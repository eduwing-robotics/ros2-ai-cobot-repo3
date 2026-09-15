// 촬영 모드 — 기존 트윈을 다시 만들지 않고, 촬영에 필요한 화면 상태만 한 번에 묶는다.
// 실제 로봇 명령은 전혀 보내지 않는다. 터틀봇 자세·이동 판정도 기존 읽기 전용 상태를 받는다.
import { RobotTwin } from './RobotTwin.jsx';

export function CaptureTwin({ capture = false, amrMoving = false, ...twinProps }) {
  return (
    <>
      <RobotTwin {...twinProps} carrierOnAmr={capture} amrMoving={capture && amrMoving} />
      {capture && (
        <div className="capturehud" data-t="capture-hud" data-moving={String(amrMoving)}>
          <b>촬영 모드</b>
          <span>{amrMoving ? '터틀봇 주행 · 가상 컨베이어 작동' : '터틀봇 대기 · 가상 컨베이어 정지'}</span>
          <small>FR5는 고스트만 추종 · 실기는 움직이지 않음</small>
        </div>
      )}
    </>
  );
}
