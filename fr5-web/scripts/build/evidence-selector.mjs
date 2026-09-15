#!/usr/bin/env node
// 발표용 증거 사진·영상을 한 화면에서 고르고, 선택 결과를 JSON으로 내보낸다.
// 원본은 건드리지 않는다. 연속 렌더 프레임은 발표 후보가 아니므로 목록에서 제외한다.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, 'scratchpad');
const JSON_OUT = join(OUT_DIR, 'evidence-catalog.json');
const HTML_OUT = join(OUT_DIR, 'evidence-selector.html');
const MEDIA = /\.(png|jpe?g|gif|mp4|mov|webm)$/i;
const VIDEO = /\.(mp4|mov|webm)$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FRAME = /^f\d{3,5}\.(png|jpe?g)$/i;

const roots = [
  join(ROOT, 'docs', 'evidence'),
  join(ROOT, 'docs', 'archive', 'evidence-2026-07'),
];

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function repoPath(path) {
  return relative(ROOT, path).split(sep).join('/');
}

function dayOf(path) {
  return path.split(sep).find((part) => DATE.test(part)) || '날짜 미상';
}

function isFrameDump(path) {
  const parts = repoPath(path).split('/');
  return parts.includes('frames') || FRAME.test(basename(path));
}

function cleanCaption(text, name) {
  return text
    .replace(/^[#>\-*\s|]+/, '')
    .replace(/[`*_]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replaceAll(name, '')
    .replace(/^(그림|사진|화면)\s*[:·-]\s*/, '')
    .replace(/\|/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s:·,()/]+|[\s:·,()]+$/g, '')
    .slice(0, 140);
}

function titleOf(text) {
  return text.match(/^#\s+(.+)$/m)?.[1]?.trim() || null;
}

const dayDocs = new Map();
for (const root of roots) {
  for (const path of walk(root).filter((path) => path.endsWith('.md'))) {
    const day = dayOf(path);
    const text = readFileSync(path, 'utf8');
    const list = dayDocs.get(day) || [];
    list.push({ path, rel: repoPath(path), text, title: titleOf(text) });
    dayDocs.set(day, list);
  }
}

function directSourcesFor(path) {
  const day = dayOf(path);
  const name = basename(path);
  const parentReadme = join(dirname(path), 'README.md');
  const sidecar = path.slice(0, -extname(path).length) + '.md';
  const parentTopic = `${dirname(path)}.md`;
  const docs = dayDocs.get(day) || [];
  const matched = docs.filter((doc) =>
    doc.text.includes(name) || [parentReadme, sidecar, parentTopic].includes(doc.path),
  );
  return matched.slice(0, 5).map(({ rel, title }) => ({ path: rel, title }));
}

function captionFor(path, sources) {
  const name = basename(path);
  const docs = (dayDocs.get(dayOf(path)) || []).filter((doc) =>
    sources.some((source) => source.path === doc.rel),
  );
  for (const doc of docs) {
    for (const match of doc.text.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
      if (basename(match[2]) === name && match[1].trim()) {
        return { text: match[1].trim().slice(0, 140), status: '문서 캡션' };
      }
    }
  }
  for (const doc of docs) {
    const line = doc.text.split('\n').find((candidate) => candidate.includes(name));
    const caption = line && cleanCaption(line, name);
    if (caption) return { text: caption, status: '문서 문장' };
  }
  if (sources[0]?.title) return { text: sources[0].title, status: '문서 제목' };
  return { text: '설명 미확인', status: '미확인' };
}

function gitAdditions() {
  const map = new Map();
  let output = '';
  try {
    output = execFileSync(
      'git',
      ['log', '--diff-filter=A', '--format=@@@%h%x09%as%x09%s', '--name-only', '--', 'docs/evidence', 'docs/archive/evidence-2026-07'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
  } catch {
    return map;
  }
  let commit = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('@@@')) {
      const [hash, date, ...subject] = line.slice(3).split('\t');
      commit = { hash, date, subject: subject.join('\t') };
    } else if (commit && line.trim()) {
      map.set(line.trim(), commit);
    }
  }
  return map;
}

const commits = gitAdditions();
const docsByCommit = new Map();
for (const [path, commit] of commits) {
  if (!path.endsWith('.md')) continue;
  const doc = [...dayDocs.values()].flat().find((candidate) => candidate.rel === path);
  if (!doc) continue;
  const list = docsByCommit.get(commit.hash) || [];
  list.push({ path: doc.rel, title: doc.title });
  docsByCommit.set(commit.hash, list);
}

function sourcesFor(path) {
  const direct = directSourcesFor(path);
  const commit = commits.get(repoPath(path));
  const sameCommit = (commit && docsByCommit.get(commit.hash)) || [];
  const seen = new Set();
  return [...direct, ...sameCommit]
    .filter((source) => !seen.has(source.path) && seen.add(source.path))
    .slice(0, 5);
}

function classify(path, caption, sources) {
  const text = `${repoPath(path)} ${caption} ${sources.map((source) => source.title || '').join(' ')}`.toLowerCase();
  const rules = [
    ['AR·XR', /(^|[\s/_-])(xr|ar)([\s/_-]|$)|apriltag|marker|tag-track|앵커|겹치기/],
    ['TurtleBot·AMR', /turtle|tb-|amr|burger|터틀봇|자율주행/],
    ['비전·RGBD', /depth|rgbd|camera|cam-|vision|bullet|carrier|wrist|뎁스|카메라|총알|검출|정합/],
    ['디지털 트윈·시뮬', /sim|twin|mujoco|ghost|scene|cycle|workcell|assembly|시뮬|트윈|고스트|무대/],
    ['맵·대시보드', /dashboard|map|editor|palette|timeline|layout|f8|f10|맵|대시보드|편집|팔레트|타임라인|생산성/],
    ['FR5·로봇', /fr5|gripper|grasp|robot|teach|program|jog|pick|move|그리퍼|파지|집기|로봇/],
  ];
  const tags = rules.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  const category = tags[0] || '장비·기타';
  let evidenceKind = '화면·렌더';
  if (/실기|live|real|랩|현장|readback|phone|first-real|pick-|grasp|실물/.test(text)) evidenceKind = '실기·실물';
  else if (/bracket|bench|room|fixture|color-parts|장비|브래킷|작업대/.test(text)) evidenceKind = '장비·환경';
  if (VIDEO.test(path)) evidenceKind = '영상';
  return { category, tags, evidenceKind };
}

const allMedia = roots.flatMap((root) => walk(root).filter((path) => MEDIA.test(path)));
const candidates = allMedia.filter((path) => !isFrameDump(path));
const items = candidates.map((path) => {
  const rel = repoPath(path);
  const sources = sourcesFor(path);
  const caption = captionFor(path, sources);
  const classification = classify(path, caption.text, sources);
  const commit = commits.get(rel) || null;
  return {
    id: rel,
    path: rel,
    previewPath: relative(join(ROOT, 'scratchpad'), path).split(sep).join('/'),
    date: dayOf(path),
    type: VIDEO.test(path) ? 'video' : 'image',
    extension: extname(path).slice(1).toLowerCase(),
    bytes: statSync(path).size,
    caption: caption.text,
    captionStatus: caption.status,
    ...classification,
    sources,
    commit,
    tracked: Boolean(commit),
  };
}).sort((a, b) => b.date.localeCompare(a.date) || a.path.localeCompare(b.path));

const catalog = {
  version: 1,
  generatedAt: new Date().toISOString(),
  scope: ['docs/evidence', 'docs/archive/evidence-2026-07'],
  counts: {
    scanned: allMedia.length,
    excludedFrameDumps: allMedia.length - candidates.length,
    candidates: items.length,
    images: items.filter((item) => item.type === 'image').length,
    videos: items.filter((item) => item.type === 'video').length,
    withSourceDocument: items.filter((item) => item.sources.length).length,
    withCommit: items.filter((item) => item.commit).length,
  },
  classificationNotice: '분야와 증거 종류는 파일명·연결 문서 기반 자동 분류이며, 캡션은 문서에서만 회수했다.',
  items,
};

function escapeScriptJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

function page(data) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FR5Web 발표 증거 선택기</title>
<style>
:root{--ink:#111827;--muted:#6b7280;--line:#e5e7eb;--soft:#f8fafc;--blue:#2563eb;--blue-soft:#eff6ff;--white:#fff}
*{box-sizing:border-box}body{margin:0;background:var(--white);color:var(--ink);font-family:Pretendard,"Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif}
header{padding:54px max(28px,5vw) 30px;border-bottom:1px solid var(--line)}
.eyebrow{font-size:13px;font-weight:700;color:var(--blue);letter-spacing:.08em}.headline{margin:11px 0 8px;font-size:clamp(34px,4vw,58px);line-height:1.08;letter-spacing:-.045em}.lede{max-width:820px;margin:0;color:var(--muted);font-size:16px;line-height:1.65}
.summary{display:flex;gap:26px;flex-wrap:wrap;margin-top:25px}.summary span{font-size:14px;color:var(--muted)}.summary strong{display:block;color:var(--ink);font-size:25px;letter-spacing:-.03em}
.tools{position:sticky;top:0;z-index:10;display:grid;grid-template-columns:minmax(220px,1fr) repeat(3,minmax(130px,190px)) auto;gap:10px;padding:14px max(28px,5vw);background:rgba(255,255,255,.95);border-bottom:1px solid var(--line);backdrop-filter:blur(12px)}
input,select,button{font:inherit}input[type=search],select{width:100%;height:42px;border:1px solid var(--line);border-radius:8px;background:#fff;padding:0 12px;color:var(--ink)}button{height:42px;border:0;border-radius:8px;padding:0 15px;font-weight:700;cursor:pointer}.secondary{background:var(--soft);color:var(--ink)}.primary{background:var(--blue);color:#fff}
main{padding:28px max(28px,5vw) 120px}.status{display:flex;justify-content:space-between;gap:16px;margin-bottom:18px;color:var(--muted);font-size:14px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:18px}
.card{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:12px;background:#fff;transition:.16s ease}.card:hover{border-color:#b7c8ef;box-shadow:0 12px 32px rgba(15,23,42,.08);transform:translateY(-2px)}.card.selected{border:2px solid var(--blue);box-shadow:0 0 0 3px var(--blue-soft)}
.pick{position:absolute;z-index:2;top:12px;right:12px;width:32px;height:32px;border-radius:9px;background:rgba(255,255,255,.94);box-shadow:0 2px 10px rgba(0,0,0,.15);display:grid;place-items:center}.pick input{width:18px;height:18px;accent-color:var(--blue)}
.media{display:flex;align-items:center;justify-content:center;height:205px;background:var(--soft);border-bottom:1px solid var(--line)}.media img,.media video{width:100%;height:100%;object-fit:contain}.body{padding:16px}.meta{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-bottom:10px}.pill{font-size:11px;font-weight:700;color:var(--blue);background:var(--blue-soft);padding:4px 7px;border-radius:999px}.date{font-size:12px;color:var(--muted)}
.caption{min-height:48px;font-weight:750;font-size:16px;line-height:1.45;letter-spacing:-.015em}.caption.unknown{color:var(--muted)}.filename{margin-top:8px;color:var(--muted);font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.links{display:flex;gap:12px;margin-top:13px;font-size:12px}.links a{color:var(--blue);text-decoration:none}.commit{margin-top:10px;color:var(--muted);font-size:11px;line-height:1.45}
.bottom{position:fixed;left:50%;bottom:20px;z-index:20;transform:translateX(-50%);display:flex;align-items:center;gap:10px;width:min(860px,calc(100vw - 32px));padding:11px 12px 11px 18px;border:1px solid #cad5ea;border-radius:14px;background:rgba(255,255,255,.96);box-shadow:0 16px 50px rgba(15,23,42,.18);backdrop-filter:blur(14px)}.bottom .count{margin-right:auto;font-weight:800}.empty{padding:80px 20px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:12px}
@media(max-width:900px){.tools{grid-template-columns:1fr 1fr}.tools input[type=search]{grid-column:1/-1}.tools button{width:100%}.bottom{flex-wrap:wrap}.bottom .count{width:100%}.bottom button{flex:1}header{padding-top:38px}}
</style>
</head>
<body>
<header>
  <div class="eyebrow">FR5WEB · 9/17 프로젝트 품평회</div>
  <h1 class="headline">발표 증거 선택기</h1>
  <p class="lede">연속 렌더 프레임은 빼고, 독립 사진과 완성 영상만 모았습니다. 사진을 체크하면 선택 순서와 근거 문서가 JSON에 함께 저장됩니다.</p>
  <div class="summary">
    <span><strong>${data.counts.images}</strong>사진</span><span><strong>${data.counts.videos}</strong>영상</span><span><strong>${data.counts.excludedFrameDumps}</strong>프레임 제외</span><span><strong>${data.counts.withSourceDocument}</strong>문서 연결</span>
  </div>
</header>
<section class="tools">
  <input id="search" type="search" placeholder="파일명·설명·커밋 검색">
  <select id="category"><option value="">모든 분야</option></select>
  <select id="kind"><option value="">모든 증거 종류</option></select>
  <select id="date"><option value="">모든 날짜</option></select>
  <button id="selectedOnly" class="secondary" type="button">선택만 보기</button>
</section>
<main>
  <div class="status"><span id="visibleCount"></span><span>분야·종류는 자동 분류</span></div>
  <section id="grid" class="grid"></section>
</main>
<div class="bottom">
  <span class="count"><span id="selectedCount">0</span>개 선택</span>
  <button id="clear" class="secondary" type="button">선택 해제</button>
  <button id="fullJson" class="secondary" type="button">전체 JSON</button>
  <button id="exportJson" class="primary" type="button">선택 JSON 내보내기</button>
</div>
<script id="catalog" type="application/json">${escapeScriptJson(data)}</script>
<script>
const catalog=JSON.parse(document.getElementById('catalog').textContent);const items=catalog.items;
const state={order:JSON.parse(localStorage.getItem('fr5web-evidence-selection')||'[]'),selectedOnly:false};
state.order=state.order.filter(id=>items.some(item=>item.id===id));const selected=new Set(state.order);
const grid=document.getElementById('grid'),search=document.getElementById('search'),category=document.getElementById('category'),kind=document.getElementById('kind'),date=document.getElementById('date');
function options(el,values){for(const value of [...new Set(values)].sort().reverse()){const o=document.createElement('option');o.value=value;o.textContent=value;el.append(o)}}
options(category,items.map(x=>x.category));options(kind,items.map(x=>x.evidenceKind));options(date,items.map(x=>x.date));
function persist(){localStorage.setItem('fr5web-evidence-selection',JSON.stringify(state.order));document.getElementById('selectedCount').textContent=state.order.length}
function toggle(id,on){if(on&&!selected.has(id)){selected.add(id);state.order.push(id)}if(!on&&selected.has(id)){selected.delete(id);state.order=state.order.filter(x=>x!==id)}persist();render()}
function card(item){const article=document.createElement('article');article.className='card'+(selected.has(item.id)?' selected':'');
 const pick=document.createElement('label');pick.className='pick';const box=document.createElement('input');box.type='checkbox';box.checked=selected.has(item.id);box.addEventListener('change',()=>toggle(item.id,box.checked));pick.append(box);article.append(pick);
 const media=document.createElement('a');media.className='media';media.href=item.previewPath;media.target='_blank';media.title='원본 열기';
 const visual=document.createElement(item.type==='video'?'video':'img');visual.src=item.previewPath;visual.loading='lazy';if(item.type==='video'){visual.muted=true;visual.controls=true;visual.preload='metadata'}else visual.alt=item.caption;media.append(visual);article.append(media);
 const body=document.createElement('div');body.className='body';const meta=document.createElement('div');meta.className='meta';meta.innerHTML='<span class="pill"></span><span class="pill"></span><span class="date"></span>';meta.children[0].textContent=item.category;meta.children[1].textContent=item.evidenceKind;meta.children[2].textContent=item.date;body.append(meta);
 const cap=document.createElement('div');cap.className='caption'+(item.captionStatus==='미확인'?' unknown':'');cap.textContent=item.caption;body.append(cap);
 const file=document.createElement('div');file.className='filename';file.textContent=item.path;body.append(file);
 const links=document.createElement('div');links.className='links';const original=document.createElement('a');original.href=item.previewPath;original.target='_blank';original.textContent='원본';links.append(original);if(item.sources[0]){const source=document.createElement('a');source.href='../'+item.sources[0].path;source.target='_blank';source.textContent='검증 문서';links.append(source)}body.append(links);
 if(item.commit){const c=document.createElement('div');c.className='commit';c.textContent=item.commit.hash+' · '+item.commit.date+' · '+item.commit.subject;body.append(c)}else{const c=document.createElement('div');c.className='commit';c.textContent='미커밋 또는 생성물';body.append(c)}article.append(body);return article}
function render(){const q=search.value.trim().toLowerCase();const filtered=items.filter(item=>{if(state.selectedOnly&&!selected.has(item.id))return false;if(category.value&&item.category!==category.value)return false;if(kind.value&&item.evidenceKind!==kind.value)return false;if(date.value&&item.date!==date.value)return false;const hay=[item.path,item.caption,item.commit?.subject,...item.sources.map(x=>x.title)].join(' ').toLowerCase();return !q||hay.includes(q)});grid.replaceChildren(...filtered.map(card));if(!filtered.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='조건에 맞는 증거가 없습니다.';grid.append(empty)}document.getElementById('visibleCount').textContent=filtered.length+'개 표시';persist()}
function download(name,value){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
for(const el of [search,category,kind,date])el.addEventListener(el===search?'input':'change',render);
document.getElementById('selectedOnly').addEventListener('click',e=>{state.selectedOnly=!state.selectedOnly;e.currentTarget.textContent=state.selectedOnly?'전체 보기':'선택만 보기';render()});
document.getElementById('clear').addEventListener('click',()=>{selected.clear();state.order=[];render()});
document.getElementById('fullJson').addEventListener('click',()=>download('fr5web-evidence-catalog.json',catalog));
document.getElementById('exportJson').addEventListener('click',()=>{if(!state.order.length){alert('먼저 사진이나 영상을 선택해 주세요.');return}const chosen=state.order.map((id,index)=>({...items.find(item=>item.id===id),selectionOrder:index+1}));download('fr5web-presentation-selection.json',{version:1,exportedAt:new Date().toISOString(),count:chosen.length,items:chosen})});
render();
</script>
</body>
</html>`;
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(JSON_OUT, `${JSON.stringify(catalog, null, 2)}\n`);
writeFileSync(HTML_OUT, page(catalog));
console.log(`증거 ${catalog.counts.scanned}개 스캔 · 프레임 ${catalog.counts.excludedFrameDumps}개 제외`);
console.log(`후보 ${catalog.counts.candidates}개 · 사진 ${catalog.counts.images} · 영상 ${catalog.counts.videos}`);
console.log(`문서 연결 ${catalog.counts.withSourceDocument} · 커밋 연결 ${catalog.counts.withCommit}`);
console.log(`→ ${repoPath(HTML_OUT)}`);
console.log(`→ ${repoPath(JSON_OUT)}`);
