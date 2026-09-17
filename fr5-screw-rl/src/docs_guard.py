# -*- coding: utf-8 -*-
"""스크립트가 시작할 때 문서가 낡았는지 보고, 낡았으면 다시 만든다.

**왜 여기서 하나.** git 저장소가 아니라 훅을 못 쓰고, 파일 감시 도구(inotifywait/entr)도
깔려 있지 않다. 그래서 **상수를 실제로 쓰는 스크립트가 돌 때** 확인하는 게 가장 확실한
지점이다. 상수를 고쳤으면 그 다음에 뭔가는 돌리게 마련이다.

    import docs_guard; docs_guard.ensure()

⚠ **실기 스크립트에는 넣지 않는다.** 로봇을 움직이기 직전에 문서를 만드느라 몇 초를
  쓰는 것은 위험하고 산만하다. 시뮬·학습·뷰어 쪽에만 넣는다.
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def ensure(quiet=True):
    """낡았으면 문서를 다시 만든다. 실패해도 **호출한 스크립트를 막지 않는다.**"""
    try:
        chk = subprocess.run([sys.executable, os.path.join(HERE, "sync_docs.py"), "--check"],
                             cwd=HERE, capture_output=True, text=True, timeout=30)
        if chk.returncode == 0:
            return False
        print("📄 치수·설정이 바뀌었다 — 문서를 다시 만든다 (sync_docs.py)", flush=True)
        r = subprocess.run([sys.executable, os.path.join(HERE, "sync_docs.py")],
                           cwd=HERE, capture_output=not quiet, text=True, timeout=600)
        if r.returncode == 0:
            print("📄 문서 갱신 완료", flush=True)
        else:
            print(f"⚠ 문서 갱신 실패 (code={r.returncode}) — 계속 진행한다", flush=True)
        return True
    except Exception as e:
        # 문서 때문에 본 작업이 멈추면 안 된다
        print(f"⚠ 문서 확인 건너뜀: {e}", flush=True)
        return False
