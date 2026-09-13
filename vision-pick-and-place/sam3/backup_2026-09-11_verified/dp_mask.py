import rclpy, numpy as np, cv2
from rclpy.node import Node
from sensor_msgs.msg import Image
from rclpy.qos import qos_profile_sensor_data
O="/tmp/claude-1000/-home-kimsunil/5728c06f-96bc-41fc-8cf7-e139a821954a/scratchpad"
rclpy.init(); n=Node("dpm"); got={}
n.create_subscription(Image,"/camera/camera/aligned_depth_to_color/image_raw",
 lambda m: got.__setitem__("d",np.frombuffer(m.data,np.uint16).reshape(m.height,m.width).astype(np.float32)),qos_profile_sensor_data)
n.create_subscription(Image,"/camera/camera/color/image_raw",
 lambda m: got.__setitem__("c",np.frombuffer(m.data,np.uint8).reshape(m.height,m.width,-1)),qos_profile_sensor_data)
for _ in range(400):
    rclpy.spin_once(n,timeout_sec=0.1)
    if "d" in got and "c" in got: break
d=got["d"].copy(); d[d==0]=np.nan
# 아래 트레이 영역
x1,y1,x2,y2 = 240,195,430,360
sub=d[y1:y2,x1:x2]
valid=(~np.isnan(sub)).astype(np.uint8)*255
cv2.imwrite(f"{O}/m_valid.png", cv2.resize(valid,None,fx=3,fy=3,interpolation=cv2.INTER_NEAREST))
v=np.nan_to_num(sub,nan=340.0)
hm=np.clip((v-260)/70*255,0,255).astype(np.uint8)
cv2.imwrite(f"{O}/m_heat.png", cv2.resize(cv2.applyColorMap(hm,cv2.COLORMAP_TURBO),None,fx=3,fy=3,interpolation=cv2.INTER_NEAREST))
print("유효 비율 %.0f%%  유효 깊이 중앙 %.0f  5%%=%.0f 95%%=%.0f"%(
  valid.mean()/255*100, np.nanmedian(sub), np.nanpercentile(sub,5), np.nanpercentile(sub,95)))
# 트레이 안에서 유효화소 덩어리
m=cv2.morphologyEx(valid,cv2.MORPH_OPEN,np.ones((3,3),np.uint8))
nl,lab,st,ce=cv2.connectedComponentsWithStats(m,8)
print("\n유효깊이 덩어리 (100px+):")
for i in range(1,nl):
    ar=st[i,cv2.CC_STAT_AREA]
    if ar<100: continue
    w,h=st[i,cv2.CC_STAT_WIDTH],st[i,cv2.CC_STAT_HEIGHT]
    dv=sub[lab==i]; dv=dv[~np.isnan(dv)]
    print("  pix=(%4.0f,%4.0f) area=%5d %dx%d 종횡=%4.2f Z중앙=%6.1f Z5%%=%6.1f"%(
      ce[i][0]+x1,ce[i][1]+y1,ar,w,h,max(w,h)/max(1,min(w,h)),np.median(dv),np.percentile(dv,5)))
