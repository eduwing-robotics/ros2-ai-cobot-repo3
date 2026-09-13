import cv2
import numpy as np
from pyModbusTCP.client import ModbusClient
import time

ROBOT_IP = "192.168.213.80"
ROBOT_PORT = 502

REG_COLOR = 132
REG_GRIP = 131

REG_X = 10   # X 방향 위치 상태 레지스터
REG_Y = 11   # Y 방향 위치 상태 레지스터

REG_PIX_X = 140  # 픽셀 X 좌표 레지스터
REG_PIX_Y = 141  # 픽셀 Y 좌표 레지스터

robot_modbus = ModbusClient(host=ROBOT_IP, port=ROBOT_PORT, auto_open=True)

COLOR_RANGES = {
    "Red": [
        (np.array([0, 150, 100]), np.array([6, 255, 255])),
        (np.array([170, 150, 100]), np.array([179, 255, 255]))
    ],
    "Orange": [(np.array([7, 150, 150]), np.array([16, 255, 255]))],
    "Yellow": [(np.array([17, 100, 150]), np.array([28, 255, 255]))],
    "Blue": [(np.array([90, 100, 100]), np.array([125, 255, 255]))],
    "Green": [(np.array([36, 80, 80]), np.array([85, 255, 255]))]
}

COLOR_VALUES = {
    "Red": 1,
    "Orange": 2,
    "Yellow": 3,
    "Blue": 4,
    "Green": 5
}

CENTER_X = 319
CENTER_Y = 240
THRESHOLD =  22 # ±22 오차 허용

def write_register_safe(register, value, last_values):
    if last_values.get(register) != value:
        robot_modbus.write_single_register(register, value)
        last_values[register] = value

def detect_and_control(): 
    cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)   # 여기서 딜레이가 생김
    if not cap.isOpened():
        print("❌ 카메라를 열 수 없습니다.")
        return

    try:
        last_reg_values = {
            REG_X: -1,
            REG_Y: -1,
            REG_COLOR: -1,
            REG_GRIP: -1,
            REG_PIX_X: -1,
            REG_PIX_Y: -1
        }

        grip_sent = False
        center_stable_count = 0
        STABLE_FRAMES = 2
        

        while True:
            ret, frame = cap.read()
            if not ret:
                continue

            
            hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
            detected_color = None
            object_center_x = None
            object_center_y = None

            for color_name in ["Red", "Orange", "Yellow", "Blue", "Green"]:
                ranges = COLOR_RANGES[color_name]
                if color_name == "Red":
                    mask1 = cv2.inRange(hsv, *ranges[0])
                    mask2 = cv2.inRange(hsv, *ranges[1])
                    mask = cv2.bitwise_or(mask1, mask2)
                else:
                    mask = cv2.inRange(hsv, *ranges[0])

                kernel = np.ones((5, 5), np.uint8)
                mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
                mask = cv2.morphologyEx(mask, cv2.MORPH_DILATE, kernel)

                contours, _ = cv2.findContours(mask, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
                for cnt in contours:
                    if cv2.contourArea(cnt) > 500:
                        detected_color = color_name
                        M = cv2.moments(cnt)
                        if M["m00"] != 0:
                            object_center_x = int(M["m10"] / M["m00"])
                            object_center_y = int(M["m01"] / M["m00"])
                            cv2.circle(frame, (object_center_x, object_center_y), 10, (0, 255, 255), -1)
                        break
                if detected_color:
                    break

            # 색상값 보내기
            color_value = COLOR_VALUES[detected_color] if detected_color else 0
            write_register_safe(REG_COLOR, color_value, last_reg_values)

            # 위치값 판단해서 레지스터에 쓰기
            if object_center_x is not None and object_center_y is not None:
                # 기존 위치 판단 레지스터 쓰기
                if object_center_x < CENTER_X - THRESHOLD:
                    robot_modbus.write_single_register(129, 1)  # 왼쪽 벗어남
                elif object_center_x > CENTER_X + THRESHOLD:
                    robot_modbus.write_single_register(129, 2)  # 오른쪽 벗어남
                else:
                    robot_modbus.write_single_register(129, 0)  # 중심

                if object_center_y < CENTER_Y - THRESHOLD:
                    robot_modbus.write_single_register(130, 1)  # 위쪽 벗어남
                elif object_center_y > CENTER_Y + THRESHOLD:
                    robot_modbus.write_single_register(130, 2)  # 아래쪽 벗어남
                else:
                    robot_modbus.write_single_register(130, 0)  # 중심

                # 픽셀 좌표 그대로 보내기
                write_register_safe(REG_PIX_X, object_center_x, last_reg_values)
                write_register_safe(REG_PIX_Y, object_center_y, last_reg_values)

                # 중심 안정 판단 (X,Y 모두 중심일 때만)
                if (CENTER_X - THRESHOLD) <= object_center_x <= (CENTER_X + THRESHOLD) and \
                   (CENTER_Y - THRESHOLD) <= object_center_y <= (CENTER_Y + THRESHOLD):
                    center_stable_count += 1
                else:
                    center_stable_count = 0
                    grip_sent = False
            else:
                # 물체 미검출 시 0으로 초기화
                write_register_safe(REG_X, 0, last_reg_values)
                write_register_safe(REG_Y, 0, last_reg_values)
                write_register_safe(REG_PIX_X, 0, last_reg_values)
                write_register_safe(REG_PIX_Y, 0, last_reg_values)
                center_stable_count = 0
                grip_sent = False

            # 그리퍼 작동
            # if center_stable_count >= STABLE_FRAMES and not grip_sent:
            #     write_register_safe(REG_GRIP, 1, last_reg_values)
            #     print("그리퍼 작동 신호 전송")
            #     time.sleep(0.5)
            #     write_register_safe(REG_GRIP, 0, last_reg_values)
            #     grip_sent = True
            #     center_stable_count = 0

            # 상태 표시
            status = f"{detected_color or 'None'} | X: {object_center_x} Y: {object_center_y}"
            cv2.putText(frame, status, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255,255,255), 2)

            # 중심점 + 허용범위 표시
            cv2.circle(frame, (CENTER_X, CENTER_Y), THRESHOLD, (0, 255, 0), 2)  # 중심원
            cv2.circle(frame, (object_center_x if object_center_x else 0, object_center_y if object_center_y else 0), 10, (0, 255, 255), -1)  # 물체 중심

            cv2.imshow("Camera View", frame)

            if cv2.waitKey(1) == ord('q'):
                break
            # time.sleep(0.001)

    finally:
        cap.release()
        cv2.destroyAllWindows()
        print("🛑 종료")

if __name__ == '__main__':
    detect_and_control()
