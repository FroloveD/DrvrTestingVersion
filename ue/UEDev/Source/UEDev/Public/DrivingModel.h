/**
 * @module UEDev/DrivingModel
 * @layer pure-core-cpp
 * @role Начальная плоская кинематика; НЕ полный порт/калибровка TS-физики.
 * @invariants Метры, секунды, радианы; +z вперёд, +x влево; фиксированный шаг 1/60.
 * @tests ue/UEDev/Tests/DrivingModelTest.cpp (обычный C++17, без Unreal).
 */
#pragma once
#include <algorithm>
#include <cmath>
namespace uedev {
constexpr double Dt = 1.0 / 60.0;
constexpr double Pi = 3.14159265358979323846;
enum class Gear { P, R, N, D, M1, M2, M3, M4, M5, M6 };
inline bool Manual(Gear g) { return g >= Gear::M1 && g <= Gear::M6; }
struct Input {
    bool Gas = false, Brake = false, Boost = false;
    double Steer = 0; // -1 вправо, +1 влево; скорость вращения руля
    bool HoldSteer = false; // мышь удерживает уже выбранный угол
};
struct State {
    double X = 0, Z = 0, Heading = 0, Speed = 0, Pedal = 0, WheelDeg = 0;
    bool Engine = false, Handbrake = true, Belt = false;
    Gear Selector = Gear::P;
};
inline bool Select(State& s, Gear next, bool brake) {
    if (next == s.Selector) return true;
    const double speed = std::abs(s.Speed);
    if ((s.Selector == Gear::P || next == Gear::P) && (!s.Engine || !brake || speed > 0.35)) return false;
    const bool fromForward = s.Selector == Gear::D || Manual(s.Selector);
    const bool toForward = next == Gear::D || Manual(next);
    if (((s.Selector == Gear::R && toForward) || (fromForward && next == Gear::R)) && (!brake || speed > 0.5)) return false;
    if (next == Gear::R && s.Speed > 0.5) return false;
    if (toForward && s.Speed < -0.5) return false;
    s.Selector = next;
    return true;
}
inline bool ToggleEngine(State& s) {
    if (!s.Engine && s.Selector != Gear::P && s.Selector != Gear::N) return false;
    s.Engine = !s.Engine;
    return true;
}
inline void Step(State& s, const Input& in) {
    const bool forward = s.Selector == Gear::D || Manual(s.Selector);
    const bool fast = in.Boost && forward;
    const double target = in.Gas ? (fast ? 1.0 : 0.6) : 0.0;
    const double rate = target < s.Pedal ? 8.0 : fast ? 12.0 : 0.45;
    s.Pedal = in.Gas ? s.Pedal + std::clamp(target - s.Pedal, -rate * Dt, rate * Dt) : 0.0;
    const double steer = std::clamp(in.Steer, -1.0, 1.0);
    if (std::abs(steer) > 0.001) s.WheelDeg = std::clamp(s.WheelDeg + steer * 340.0 * Dt, -540.0, 540.0);
    else if (!in.HoldSteer) s.WheelDeg += std::clamp(-s.WheelDeg, -220.0 * Dt, 220.0 * Dt);
    if (s.Selector == Gear::P) { s.Speed = 0; return; }
    const double v = std::abs(s.Speed);
    // N: только качение и воздух. Это начальный стенд, не паспортная модель двигателя.
    double resistance = 0.148 + 0.000331 * v * v + 0.0029 * v;
    if (s.Selector != Gear::N && s.Engine) resistance += (1.0 - s.Pedal) * 0.6;
    double drive = 0;
    if (s.Engine && !s.Handbrake && !in.Brake) {
        if (forward) drive = s.Pedal * 4.08;
        if (s.Selector == Gear::R) drive = -s.Pedal * 2.45;
    }
    // Сначала тяга, затем сопротивление/тормоза: S никогда не включает задний ход.
    s.Speed += drive * Dt;
    const double decel = resistance + (in.Brake ? (in.Boost ? 8.4 : 6.2) : 0.0) + (s.Handbrake ? 8.5 : 0.0);
    s.Speed = std::copysign(std::max(0.0, std::abs(s.Speed) - decel * Dt), s.Speed);
    s.Speed = std::clamp(s.Speed, -14.0 / 3.6, 50.0);
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
