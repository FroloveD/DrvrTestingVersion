/**
 * @module UEDev/HudModel
 * @layer pure-presentation-cpp
 * @role Данные понятного HUD: приоритет подсказок, дистанция до КТ, адаптивный масштаб.
 * @invariants Не меняет физику/прогресс; нет экзаменационной оценки и вымышленных индикаторов.
 * @tests DrivingModelTest.cpp: приоритеты, завершение, расстояние, размеры экрана.
 */
#pragma once
#include "DrivingModel.h"
#include "RouteRun.h"
namespace uedev {
enum class HudHint { StartEngine, ParkOrNeutral, Belt, Handbrake, LeavePark, LeaveNeutral, FollowRoute, Finished };
inline HudHint NextHint(const State& s, bool done) {
    if (done) return HudHint::Finished;
    if (!s.Engine) return s.Selector==Gear::P || s.Selector==Gear::N ? HudHint::StartEngine : HudHint::ParkOrNeutral;
    if (!s.Belt) return HudHint::Belt;
    if (s.Handbrake) return HudHint::Handbrake;
    if (s.Selector==Gear::P) return HudHint::LeavePark;
    if (s.Selector==Gear::N) return HudHint::LeaveNeutral;
    return HudHint::FollowRoute;
}
inline double CheckpointDistance(const State& s, const TestRoute& route, const RouteRun& run) {
    if (run.Done(route) || run.Next<0) return 0;
    const auto& point=route.Points[run.Next];
    // До границы зоны, не длина пути по дороге.
    return std::max(0.0,std::hypot(s.X-point.X,s.Z-point.Z)-point.Radius);
}
// Углы соответствуют направлениям от глаз (-30,-38,58) к боковым зеркалам.
constexpr double LeftMirrorYaw=-32, RightMirrorYaw=55;
inline double HeadYaw(double yaw, bool left, bool right, double dt) {
    if (left==right) return yaw;
    const double target=left ? LeftMirrorYaw : RightMirrorYaw;
    const double amount=360*std::clamp(dt,0.0,0.1);
    return yaw+std::clamp(target-yaw,-amount,amount);
}
inline double HeadReturnRate(double value) {
    return std::isfinite(value) ? std::clamp(value,540.0,900.0) : 720.0;
}
struct HeadLook {
    bool Returning=false, WasLeft=false, WasRight=false;
    int Locked=0, LastTap=0;
    double Clock=0, LastTapTime=-1;
    double Step(double yaw, bool left, bool right, double dt, double returnRate = 720) {
        Clock+=std::max(0.0,dt);
        const int pressed=left && !WasLeft && !right ? -1 : right && !WasRight && !left ? 1 : 0;
        WasLeft=left; WasRight=right;
        if (pressed) {
            const bool twice=LastTap==pressed && Clock-LastTapTime<=0.28;
            Locked=twice ? pressed : 0;
            LastTap=twice ? 0 : pressed;
            LastTapTime=Clock;
        }
        if (Locked) return HeadYaw(yaw,Locked<0,Locked>0,dt);
        if (left || right) { Returning=true; return HeadYaw(yaw,left,right,dt); }
        if (!Returning) return yaw;
        const double amount=HeadReturnRate(returnRate)*std::clamp(dt,0.0,0.1);
        const double next=yaw+std::clamp(-yaw,-amount,amount);
        if (next==0) Returning=false;
        return next;
    }
};
inline double InstrumentRoll(double value, double maximum) {
    const double fraction=std::isfinite(value) && maximum>0 ? std::clamp(value/maximum,0.0,1.0) : 0;
    return 120-240*fraction;
}
inline double HudScale(double width, double height) {
    return std::clamp(std::min(width/1280.0,height/720.0),0.01,1.5);
}
}
