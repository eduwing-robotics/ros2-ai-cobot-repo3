# ROS 접점의 유일한 경계 (TB-CONTRACT.md · D30). 이 밖에서는 rclpy 를 import 하지 않는다.
# 단위 변환(m·rad ↔ mm·도)도 이 경계 안에서만 한다.


class RosAdapter:
    """mock.py 와 real.py 가 같은 얼굴을 갖는다. 값의 단위는 전부 mm·도(바깥면 규칙)."""

    def robots(self) -> dict:
        """로봇별 공개 상태 dict — TB-CONTRACT §상태의 robots 값 그대로."""
        raise NotImplementedError

    def set_velocity(self, robot: str, linear_mm_s: float, angular_deg_s: float) -> None:
        raise NotImplementedError

    def stop(self, robot: str) -> None:
        """cmd_vel 0. 슬롯 프로세스가 어떻게 죽었든 브리지가 이걸 부른다 (§안전 규칙)."""
        raise NotImplementedError

    def reset_odom(self, robot: str) -> tuple:
        """지금 자세를 (0,0,0) 으로. 반환 (성공, 사유). 계약 §원점 재설정."""
        raise NotImplementedError

    def set_mode(self, robot: str, mode: str) -> None:
        raise NotImplementedError

    def set_active_map(self, robot: str, map_name: str | None) -> None:
        raise NotImplementedError
