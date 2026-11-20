/**
 * @module UEDev/RouteRun
 * @layer pure-core-cpp
 * @role Технические тестовые маршруты и последовательные КТ/остановка/статистика.
 * @invariants SI; это не экзаменационные упражнения/штрафы; пауза не вызывает Advance.
 * @tests DrivingModelTest.cpp: порядок, пересечение за шаг, остановка, сброс, статистика.
 */
#pragma once
#include <algorithm>
#include <array>
#include <cmath>
namespace uedev {
struct RoutePoint { double X=0, Z=0, Radius=5; bool Stop=false; };
struct TestRoute {
    int Id=0;
    double HalfForward=60, HalfSide=40, StartZ=0;
    std::array<RoutePoint,4> Points{};
    int Count=0;
};
inline TestRoute Route(int id) {
    if (id==1) return {1,600,20,-500, {{{0,-250,10,false},{0,0,10,false},{0,250,10,false},{0,500,10,true}}},4};
    return {0,60,40,0, {{{0,15,4,false},{0,35,5,true},{},{}}},2};
}
struct RouteRun {
    int Next=0;
    double Seconds=0, Distance=0, MaxKmh=0;
    bool Done(const TestRoute& route) const { return Next>=route.Count; }
    void Advance(const TestRoute& route,double x0,double z0,double x,double z,double speed,double dt) {
        if (Done(route) || dt<=0) return;
        Seconds+=dt;
        Distance+=std::hypot(x-x0,z-z0);
        MaxKmh=std::max(MaxKmh,std::abs(speed)*3.6);
        const auto& point=route.Points[Next];
        const double dx=x-x0,dz=z-z0, length2=dx*dx+dz*dz;
        const double t=length2>0 ? std::clamp(((point.X-x0)*dx+(point.Z-z0)*dz)/length2,0.0,1.0) : 0;
        const bool hit=std::hypot(x0+t*dx-point.X,z0+t*dz-point.Z)<=point.Radius;
        const bool stopped=std::abs(speed)<0.15 && std::hypot(x-point.X,z-point.Z)<=point.Radius;
        if (hit && (!point.Stop || stopped)) ++Next;
    }
};
inline double OrdinaryGasLimit(double value) {
    return std::isfinite(value) ? std::clamp(value,0.1,0.6) : 0.6;
}
}
