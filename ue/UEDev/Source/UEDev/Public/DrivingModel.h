/**
 * @module UEDev/DrivingModel
 * @layer pure-core-cpp
 * @role Плоская кинематика и продольная динамика Ceed; ещё не полный порт TS-сценариев.
 * @invariants Метры, секунды, радианы; +z вперёд, +x влево; фиксированный шаг 1/60.
 * @tests ue/UEDev/Tests/DrivingModelTest.cpp (обычный C++17, без Unreal).
 */
#pragma once
#include <algorithm>
#include <cmath>
#include "Powertrain.h"
namespace uedev {
constexpr double Dt = 1.0 / 60.0;
constexpr double Pi = 3.14159265358979323846;
enum class Gear { P, R, N, D, M1, M2, M3, M4, M5, M6 };
inline bool Manual(Gear g) { return g >= Gear::M1 && g <= Gear::M6; }
struct Input {
    bool Gas = false, Brake = false, Boost = false;
    double Steer = 0; // -1 вправо, +1 влево; скорость вращения руля
    bool HoldSteer = false; // мышь удерживает уже выбранный угол
    double GasLimit = 0.6; // обычный газ 10..60 %, Shift в D/M — 100 %
};
struct State {
    double X = 0, Z = 0, Heading = 0, Speed = 0, Pedal = 0, WheelDeg = 0;
    bool Engine = false, Handbrake = true, Belt = false;
    Gear Selector = Gear::P;
    int AutoGear = 1;
    double Throttle = 0, BrakePressure = 0, Rpm = 0, ShiftTimer = 0;
};
// Визуальная политика прототипа: не изменяет состояние/динамику и не является оценкой.
struct LightState { bool Head, Stop, Reverse; };
inline LightState Lights(const State& s, bool headlights = false) {
    return {headlights, s.BrakePressure > 0.02, s.Engine && s.Selector == Gear::R};
}
inline bool Select(State& s, Gear next, bool brake) {
    if (next == s.Selector) return true;
    const double speed = std::abs(s.Speed);
    if ((s.Selector == Gear::P || next == Gear::P) && (!s.Engine || !brake || speed > 0.35)) return false;
    const bool fromForward = s.Selector == Gear::D || Manual(s.Selector);
    const bool toForward = next == Gear::D || Manual(next);
    if (((s.Selector == Gear::R && toForward) || (fromForward && next == Gear::R)) && (!brake || speed > 0.5)) return false;
    if (next == Gear::R && s.Speed > 0.5) return false;
    if (toForward && s.Speed < -0.5) return false;
    if (Manual(next)) {
        const int number = static_cast<int>(next)-static_cast<int>(Gear::M1)+1;
        if (s.Speed*3.6 > GearCap[number]*0.96) return false;
        if (number != s.AutoGear) s.ShiftTimer = 0.18;
        s.AutoGear = number;
    }
    s.Selector = next;
    return true;
}
inline bool ToggleEngine(State& s) {
    if (!s.Engine && s.Selector != Gear::P && s.Selector != Gear::N) return false;
    s.Engine = !s.Engine;
    return true;
}
// Подготовка на месте: не сброс. На ходу/R/M — отказ без частичных изменений.
inline bool PrepareDrive(State& s, bool brake) {
    if (std::abs(s.Speed) > 0.35 || (s.Selector != Gear::P && s.Selector != Gear::N && s.Selector != Gear::D)) return false;
    State next = s;
    if (!next.Engine && !ToggleEngine(next)) return false;
    if (!Select(next, Gear::D, brake)) return false;
    next.Handbrake = false;
    next.Belt = true;
    s = next;
    return true;
}
inline void Step(State& s, const Input& in) {
    const bool forward = s.Selector == Gear::D || Manual(s.Selector);
    const bool fast = in.Boost && forward;
    const double target = in.Gas ? (fast ? 1.0 : Clamp(in.GasLimit,0.1,0.6)) : 0.0;
    const double rate = target < s.Pedal ? 8.0 : fast ? 12.0 : 0.45;
    s.Pedal = in.Gas ? s.Pedal + std::clamp(target - s.Pedal, -rate * Dt, rate * Dt) : 0.0;
    const double steer = std::clamp(in.Steer, -1.0, 1.0);
    if (std::abs(steer) > 0.001) s.WheelDeg = std::clamp(s.WheelDeg + steer * 340.0 * Dt, -540.0, 540.0);
    else if (!in.HoldSteer) s.WheelDeg += std::clamp(-s.WheelDeg, -220.0 * Dt, 220.0 * Dt);
    const double brake = in.Brake ? 1.0 : 0.0;
    const double tau = brake > s.BrakePressure ? 0.34/(in.Boost ? 2 : 1) : 0.13;
    s.BrakePressure += (brake-s.BrakePressure)*std::min(1.0,Dt/tau);
    if (!in.Brake && s.BrakePressure < 0.001) s.BrakePressure = 0;
    const double command = s.Engine && !in.Brake ? s.Pedal : 0;
    s.Throttle += (command-s.Throttle)*std::min(1.0,Dt*(command>s.Throttle ? 10.5 : 18));
    if (command==0 && s.Throttle<0.001) s.Throttle=0;
    s.ShiftTimer=std::max(0.0,s.ShiftTimer-Dt);
    if (Manual(s.Selector)) {
        s.AutoGear=static_cast<int>(s.Selector)-static_cast<int>(Gear::M1)+1;
        // Защита от заглохания, как в TS: понижение ступени на малой скорости.
        constexpr double stall[]={0,0,7,15,25,36,48};
        if (s.AutoGear>1 && s.Speed*3.6<stall[s.AutoGear]) {
            --s.AutoGear;
            s.Selector=static_cast<Gear>(static_cast<int>(Gear::M1)+s.AutoGear-1);
            s.ShiftTimer=0.18;
        }
    } else if (s.Selector==Gear::D) {
        const double sport=Clamp((s.Throttle-0.35)/0.55,0,1), kmh=std::max(0.0,s.Speed*3.6);
        const int g=s.AutoGear;
        if (s.ShiftTimer==0 && g<6 && kmh>=Up[g]+(UpSport[g]-Up[g])*sport) { ++s.AutoGear; s.ShiftTimer=0.24; }
        else if (s.ShiftTimer==0 && g>1 && kmh<Down[g]+(DownKick[g]-Down[g])*sport*sport) { --s.AutoGear; s.ShiftTimer=0.18; }
    } else { s.AutoGear=1; s.ShiftTimer=0; }
    const int mode=forward ? s.AutoGear : s.Selector==Gear::R ? -1 : 0;
    if (s.Selector==Gear::P) s.Speed=0;
    else {
        const double before=s.Speed;
        double accel=EngineAccel(s.Throttle,mode,s.Speed,s.Engine,s.Handbrake,s.ShiftTimer)
            +Creep(s.Speed,s.Throttle,s.BrakePressure,mode==1 && s.Engine && !s.Handbrake);
        const double drag=RoadDrag(std::abs(s.Speed),s.Throttle,mode,s.Engine);
        if (s.Speed!=0) accel-=std::copysign(drag,s.Speed);
        else accel=std::copysign(std::max(0.0,std::abs(accel)-drag),accel);
        s.Speed+=accel*Dt;
        if (before*s.Speed<0) s.Speed=0;
        s.Speed=Clamp(s.Speed,-14.0/3.6,50);
        const double decel=ServiceBrake(s.BrakePressure,std::abs(s.Speed),in.Boost)+(s.Handbrake ? 8.5 : 0);
        s.Speed=std::copysign(std::max(0.0,std::abs(s.Speed)-decel*Dt),s.Speed);
    }
    s.Rpm=EngineRpm(s.Rpm,s.Throttle,mode,s.Speed,s.Engine,s.ShiftTimer,s.BrakePressure,s.Handbrake,Dt);
    const double maxDelta = std::atan(1.0 / (1.0 / std::tan(35.0 * Pi / 180.0) + 1.57 / (2.0 * 2.65)));
    s.Heading += s.Speed / 2.65 * std::tan(s.WheelDeg / 540.0 * maxDelta) * Dt;
    s.X += std::sin(s.Heading) * s.Speed * Dt;
    s.Z += std::cos(s.Heading) * s.Speed * Dt;
}
inline const char* Label(Gear g) {
    switch (g) {
        case Gear::P: return "P"; case Gear::R: return "R"; case Gear::N: return "N"; case Gear::D: return "D";
        case Gear::M1: return "M1"; case Gear::M2: return "M2"; case Gear::M3: return "M3";
        case Gear::M4: return "M4"; case Gear::M5: return "M5"; case Gear::M6: return "M6";
    }
    return "?";
}
} // namespace uedev
