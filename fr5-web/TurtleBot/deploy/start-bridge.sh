#!/bin/bash
# tb-bridge 기동 (real · 도메인 210 · fastrtps · IPv6 포함 바인드)
source /opt/ros/jazzy/setup.bash
source "$HOME/turtlebot3_ws/install/setup.bash"
export TB_ADAPTER=real ROS_DOMAIN_ID=210 RMW_IMPLEMENTATION=rmw_fastrtps_cpp
cd "$HOME/tb-bridge" || exit 1
exec python3 -m uvicorn main:app --host 0.0.0.0 --port 5056 >> /tmp/tb-bridge.log 2>&1
