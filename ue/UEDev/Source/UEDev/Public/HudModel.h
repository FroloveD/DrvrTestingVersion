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
// Стрелки головы независимы от селектора: влево/вправо, скорость 85°/с.
inline double HeadYaw(double yaw, bool left, bool right, double dt) {
    return std::clamp(yaw+((right ? 1.0 : 0.0)-(left ? 1.0 : 0.0))*85*std::clamp(dt,0.0,0.1),-110.0,110.0);
}
inline double HudScale(double width, double height) {
    return std::clamp(std::min(width/1280.0,height/720.0),0.01,1.5);
}
}
