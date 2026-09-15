// cdp-harness.mjs — Playwright/Puppeteer 없이 헤드리스 Chrome을 CDP로 구동하는 재사용 하네스.
// 의존성 0. 요구: Node ≥ 22(전역 WebSocket·fetch) + 로컬 Chrome/Chromium.
//
// 쓰는 이유: 보호 라우트 스크린샷, 세션(localStorage) 주입, React 입력 주입, 멀티탭,
// 중첩 iframe 접근, window.__probe 구동, 표정/렌더 before-after 픽셀 diff, 콘솔에러 수집 —
// 이 모두를 무거운 브라우저 자동화 의존성 없이 한다.
//
// 예:
//   import { openPage, pixelChanged } from './cdp-harness.mjs'
//   const p = await openPage('http://localhost:5173/lobby', { port: 9333 })
//   await p.setLocalStorage('sb-<ref>-auth-token', sessionJson)   // 세션 주입
//   await p.navigate('http://localhost:5173/lobby')               // 재로드
//   await p.waitFor(`document.querySelector('h1')?.innerText.includes('로비')`)
//   const before = await p.screenshot()
//   await p.eval(`window.__probe?.setParameterValues({ParamMouthOpenY:1})`)
//   const after = await p.screenshot('after.png')
//   console.log('반응:', pixelChanged(before, after) ? 'PASS' : 'FAIL', '| 에러:', p.consoleErrors)
//   p.close()

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

function resolveChrome(explicit) {
  if (explicit) return explicit
  const found = CHROME_CANDIDATES.find((p) => p.startsWith('/') && existsSync(p))
  if (found) return found
  return 'google-chrome' // PATH 폴백 (없으면 spawn 실패로 드러남)
}

/**
 * 헤드리스 Chrome을 띄우고 CDP 세션 API를 돌려준다.
 * @param {string} url 초기 URL
 * @param {object} opts { port, chrome, userDataDir, windowSize, fakeMedia, extraFlags }
 *   fakeMedia=true → getUserMedia 자동허용 + 가짜 카메라/마이크(웹캠 페이지 스모크용, 실얼굴은 안 나옴)
 */
export async function openPage(url, opts = {}) {
  const {
    port = 9333,
    chrome,
    userDataDir = `/tmp/cdp-profile-${port}`,
    windowSize = '1200,800',
    fakeMedia = false,
    extraFlags = [],
  } = opts

  const bin = resolveChrome(chrome)
  const flags = [
    '--headless=new', '--hide-scrollbars', '--disable-gpu-sandbox',
    `--window-size=${windowSize}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    ...(fakeMedia
      ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
      : []),
    ...extraFlags,
    url,
  ]
  const proc = spawn(bin, flags, { stdio: 'ignore' })

  // CDP page 타깃 탐색
  let wsUrl = null
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    try {
      const list = await (await fetch(`http://localhost:${port}/json`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) { wsUrl = page.webSocketDebuggerUrl; break }
    } catch { /* Chrome 아직 안 뜸 */ }
  }
  if (!wsUrl) { proc.kill(); throw new Error(`CDP 타깃 못 찾음(port ${port}) — Chrome 설치/경로 확인`) }

  const ws = new WebSocket(wsUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const pending = new Map()
  const consoleErrors = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
    else if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('EXC: ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text))
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push('console.error: ' + m.params.args.map((a) => a.value || a.description || '').join(' '))
    }
  }
  const send = (method, params = {}) =>
    new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })

  await send('Page.enable')
  await send('Runtime.enable')

  return {
    consoleErrors,
    raw: send,
    /** 페이지 컨텍스트에서 표현식 평가(프로미스 await 지원). 예외 시 throw. */
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
      return r?.result?.value
    },
    /** expr가 truthy 될 때까지 폴링. 타임아웃 시 null. */
    async waitFor(expr, { timeoutMs = 30000, intervalMs = 500 } = {}) {
      const tries = Math.ceil(timeoutMs / intervalMs)
      for (let i = 0; i < tries; i++) {
        const v = await this.eval(`(()=>{ try { return (${expr}) } catch(e){ return null } })()`).catch(() => null)
        if (v) return v
        await sleep(intervalMs)
      }
      return null
    },
    async setLocalStorage(key, value) {
      await this.eval(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)}); 'ok'`)
    },
    async navigate(u) {
      await send('Page.navigate', { url: u })
      await sleep(600)
    },
    /** React 제어 input에 값 주입 + form submit (실제 onChange/onSubmit 경로). */
    async typeAndSubmit(inputSelector, text, formSelector = 'form') {
      await this.eval(`(() => {
        const input = document.querySelector(${JSON.stringify(inputSelector)});
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector(${JSON.stringify(formSelector)}).requestSubmit();
        return 'sent';
      })()`)
    },
    /** PNG 스크린샷. clip={x,y,width,height}면 해당 영역만. file 주면 저장. Buffer 반환. */
    async screenshot(file, clip) {
      const { data } = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
      const buf = Buffer.from(data, 'base64')
      if (file) writeFileSync(file, buf)
      return buf
    },
    /** 요소 bounding rect(스크린샷 clip용). */
    async rect(selector) {
      return this.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      })()`)
    },
    close() { try { ws.close() } catch { /* noop */ } proc.kill() },
  }
}

/** before/after 스크린샷 Buffer가 다른가(=렌더 반응 발생). */
export function pixelChanged(a, b) {
  return !Buffer.isBuffer(a) || !Buffer.isBuffer(b) || !a.equals(b)
}
