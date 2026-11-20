/**
 * @module UEDev/Powertrain
 * @layer pure-core-cpp
 * @role Продольные функции Ceed из src/sim/vehicle.ts: тяга, сопротивления, RPM, тормоз, самоход.
 * @invariants SI, шаг передаётся явно; mode 0=P/N, -1=R, 1..6=передняя ступень.
 * @tests DrivingModelTest.cpp; полный паритет всего TS stepSimulation не заявляется.
 */
#pragma once
#include <algorithm>
#include <cmath>
namespace uedev {
inline double Clamp(double v, double a, double b) { return std::clamp(v, a, b); }
inline constexpr double GearCap[] = {0,48,84,122,154,175,180};
inline constexpr double RpmRatio[] = {0,133,76,52.5,41.6,35.4,29};
inline constexpr double PeakAccel[] = {0,4.08,3.04,2.32,1.88,1.62,1.48};
inline constexpr double Up[] = {0,21,38,56,76,102,999};
inline constexpr double UpSport[] = {0,45.5,80.5,117.5,149,170.5,999};
inline constexpr double Down[] = {0,0,13,27,43,60,80};
inline constexpr double DownKick[] = {0,0,36,68,102,132,154};
inline double Torque(double rpm) {
    if (rpm <= 1200) return 0.72 + 0.1 * Clamp((rpm-800)/400,0,1);
    if (rpm <= 2800) return 0.82 + 0.11 * (rpm-1200)/1600;
    if (rpm <= 4850) return 0.93 + 0.07 * (rpm-2800)/2050;
    if (rpm <= 6250) return 1 - 0.1 * (rpm-4850)/1400;
    return rpm <= 6530 ? 0.9 * Clamp(1-(rpm-6250)/260,0,1) : 0;
}
inline double EngineAccel(double th, int mode, double speed, bool engine, bool handbrake, double shift) {
    if (!engine || handbrake || !mode || th <= 0) return 0;
    th = Clamp(th,0,1);
    if (mode == -1) {
        const double kmh = std::max(0.0,-speed*3.6);
        return kmh >= 14 ? 0 : -2.45 * std::pow(th,0.65) * Clamp(1-kmh/15.2,0.14,1);
    }
    const double kmh = std::max(0.0,speed*3.6);
    if (kmh >= 180 || (mode < 6 && kmh >= GearCap[mode])) return 0;
    double limit = mode < 6 && kmh > GearCap[mode]-1.2 ? (GearCap[mode]-kmh)/1.2 : 1;
    if (kmh > 179.2) limit = std::min(limit,0.78+0.22*(180-kmh)/0.8);
    const double wheelRpm = kmh * RpmRatio[mode];
    const double lockup = Clamp((wheelRpm-700)/1700,0,1);
    const double rpm = std::max(800.0,wheelRpm+th*1050*(1-lockup*0.92));
    const double launch = mode == 1 ? 1+0.1*(1-Clamp(kmh/18,0,1)) : 1;
    return th * PeakAccel[mode] * Torque(rpm) * launch * (shift > 0 ? 0.14 : 1) * limit;
}
inline double RoadDrag(double v, double th, int mode, bool engine) {
    const double natural = 0.148+0.000331*v*v+0.0029*v;
    if (!mode) return natural; // N не связан с мотором
    const double coast = std::pow(Clamp(1-th,0,1),1.3);
    const double settle = 0.095*(1-Clamp(v/0.72,0,1));
    if (mode == -1) return 0.24+0.018*v+coast*(0.36+0.055*v+settle);
    if (!engine) return natural+0.22+settle;
    constexpr double ratio[] = {0,5.6,3.1,1.95,1.4,1.08,0.86};
    const double kmh=v*3.6, rpm=kmh*RpmRatio[mode];
    const double fade= mode==1 ? Clamp((kmh-5)/6.5,0,1) : Clamp((kmh-3.5)/6,0,1);
    return natural+coast*(0.16+0.19*ratio[mode])*(0.58+0.82*Clamp((rpm-1050)/3600,0,1))*fade;
}
inline double ServiceBrake(double brake, double v, bool boost) {
    if (brake <= 0.001) return 0;
    return 8.4*(0.06+0.94*std::pow(Clamp(brake,0,1),1.9))*(1-0.06*Clamp((v*3.6-90)/90,0,1))
        *(0.58+0.42*Clamp(v/0.6,0,1))*(boost ? 1.18 : 1);
}
inline double Creep(double speed, double th, double brake, bool enabled) {
    if (!enabled || speed < -0.05) return 0;
    const double kmh=std::max(0.0,speed*3.6);
    if (kmh >= 5) return 0;
    return Clamp(1-brake/0.16,0,1)*(1-Clamp(th*2.6,0,1))*(0.153+0.09*std::pow(1-kmh/5,0.62));
}
inline double SlewRpm(double rpm, double target, double rate, double slew, double dt) {
    return rpm+Clamp((target-rpm)*std::min(1.0,dt*rate),-slew*dt,slew*dt);
}
inline double EngineRpm(double rpm, double th, int mode, double speed, bool engine, double shift, double brake, bool handbrake, double dt) {
    if (!engine) { const double next=SlewRpm(rpm,0,4.6,3600,dt); return next < 8 ? 0 : next; }
    double target, rate, slew;
    if (!mode) {
        target=800+std::pow(th,0.92)*(6450-800);
        rate=target>rpm ? 4.2 : 8; slew=target>rpm ? 5400 : 7000;
    } else {
        const double kmh=std::abs(speed)*3.6;
        const double idle=kmh<0.35 && th<0.02 && (brake>0.16 || handbrake) ? 765 : 800;
        if (mode==-1) {
            target=Clamp(idle+kmh*118+th*780,idle,3600);
            rate=target>rpm ? 4.8 : 5.2; slew=target>rpm ? 3800 : 4200;
        } else {
            const double coupled=kmh*RpmRatio[mode], lockup=Clamp((coupled-700)/1700,0,1);
            target=Clamp(std::max(idle,coupled+th*1050*(1-lockup*0.92)*(shift>0 ? 0.2 : 1)),idle,6450);
            rate=shift>0 ? 7.2 : target>rpm ? 5.6 : 6;
            slew=shift>0 ? 7800 : target>rpm ? 5000 : 6200;
        }
    }
    return Clamp(SlewRpm(rpm,target,rate,slew,dt),0,6500);
}
}
