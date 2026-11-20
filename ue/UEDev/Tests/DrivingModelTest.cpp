#include "DrivingModel.h"
#include "SessionFlow.h"
#include "RouteRun.h"
#include <limits>
#include <cstdlib>
#include <iostream>
using namespace uedev;
void Check(bool ok, const char* message) {
    if (!ok) { std::cerr << "FAIL " << message << '\n'; std::exit(1); }
}
int main() {
    SessionFlow flow;
    Check(!flow.CanDrive() && !flow.Apply(Action::Resume) && !flow.Apply(Action::Finish), "menu ignores resume/finish");
    Check(flow.Apply(Action::Start) && flow.CanDrive(), "start -> driving");
    Check(!flow.Apply(Action::Home) && !flow.Apply(Action::Restart), "no silent discard while driving");
    Check(flow.Apply(Action::Pause) && !flow.CanDrive(), "pause blocks model");
    Check(flow.Apply(Action::Resume) && flow.CanDrive(), "resume -> driving");
    Check(flow.Apply(Action::Pause) && flow.Apply(Action::Restart) && flow.CanDrive(), "paused restart");
    Check(flow.Apply(Action::Pause) && flow.Apply(Action::Finish) && flow.Current == Screen::Summary, "finish -> summary");
    Check(!flow.Apply(Action::Resume) && flow.Apply(Action::Restart), "summary new attempt");
    Check(flow.Apply(Action::Pause) && flow.Apply(Action::Home) && flow.Current == Screen::Menu, "home from pause");
    Check(flow.Apply(Action::Start) && flow.Apply(Action::Pause) && flow.Apply(Action::Finish) && flow.Apply(Action::Home), "summary home");
    const auto straight=Route(1);
    Check(straight.Count==4 && straight.StartZ==-500 && straight.HalfForward>500,"long route geometry");
    Check(Route(999).Id==0,"unknown route falls back to yard");
    RouteRun run;
    run.Advance(straight,0,240,0,260,20,Dt);
    Check(run.Next==0,"cannot skip first checkpoint");
    run.Advance(straight,0,-270,0,-230,20,Dt);
    Check(run.Next==1,"swept checkpoint not missed at speed");
    run.Advance(straight,0,-20,0,20,20,Dt);
    run.Advance(straight,0,230,0,270,20,Dt);
    Check(run.Next==3,"ordered checkpoint advancement");
    run.Advance(straight,0,490,0,500,10,Dt);
    Check(!run.Done(straight),"stop checkpoint needs low speed");
    run.Advance(straight,0,500,0,500,0,Dt);
    Check(run.Done(straight) && run.Distance>0 && run.Seconds>0 && run.MaxKmh==72,"stop and stats");
    const double completedTime=run.Seconds;
    run.Advance(straight,0,500,0,510,20,Dt);
    Check(run.Seconds==completedTime,"completed metrics frozen");
    run=RouteRun{};
    Check(run.Next==0 && run.Distance==0 && run.Seconds==0,"restart clears progress");
    Check(OrdinaryGasLimit(99)==0.6 && OrdinaryGasLimit(-1)==0.1 && OrdinaryGasLimit(std::numeric_limits<double>::quiet_NaN())==0.6,"settings normalization");
    State cold;
    Check(!cold.Engine && cold.Handbrake && !cold.Belt && cold.Selector == Gear::P, "cold start");
    Check(!Select(cold, Gear::D, true), "P: engine required");
    ToggleEngine(cold);
    Check(!Select(cold, Gear::N, false), "P->N: brake required");
    Check(Select(cold, Gear::N, true) && Select(cold, Gear::D, false), "N->D: no brake");
    Check(!Select(cold, Gear::R, false), "D->R requires brake");
    State drive; drive.Engine = true; drive.Handbrake = false; drive.Selector = Gear::D;
    State fast = drive;
    for (int i = 0; i < 120; ++i) { Step(drive, {true, false, false, 0}); Step(fast, {true, false, true, 0}); }
    Check(std::abs(drive.Pedal - 0.6) < 1e-12 && fast.Pedal == 1, "normal 60%, Shift 100%");
    Check(fast.Speed > drive.Speed, "Shift accelerates faster");
    for (Gear gear : {Gear::P, Gear::R, Gear::N, Gear::D, Gear::M1, Gear::M6}) {
        State s; s.Selector = gear;
        for (int i = 0; i < 12; ++i) Step(s, {true, false, true, 0});
        Check((s.Pedal == 1) == (gear == Gear::D || Manual(gear)), "boost only D/M");
    }
    State neutral; neutral.Speed = 10; neutral.Selector = Gear::N;
    State neutralGas = neutral; neutralGas.Engine = true; neutralGas.Handbrake = false;
    neutral.Handbrake = false;
    for (int i = 0; i < 120; ++i) { Step(neutral, {}); Step(neutralGas, {true, false, true, 0}); }
    Check(neutral.Speed == neutralGas.Speed && neutral.Speed < 10, "N: natural drag independent of gas/engine");
    for (int i = 0; i < 600; ++i) Step(fast, {false, true, true, 0});
    Check(fast.Speed == 0 && fast.Pedal == 0, "brake stops, never reverses; gas releases");
    drive.Speed = 5;
    Check(!Select(drive, Gear::P, true) && !Select(drive, Gear::R, true), "speed locks");
    State left; left.Engine = true; left.Handbrake = false; left.Selector = Gear::D;
    for (int i = 0; i < 120; ++i) Step(left, {true, false, false, 1});
    Check(left.X > 0 && left.Z > 0 && left.Heading > 0, "A steers left in core coordinates");
    State held = left; Step(held, {false, false, false, 0, true});
    Check(held.WheelDeg == left.WheelDeg, "mouse holds wheel angle");
    State parked; parked.Engine = true; Step(parked, {true, false, false, 1});
    Check(parked.Speed == 0 && parked.X == 0 && parked.Z == 0, "P mechanically holds");
    Check(ToggleEngine(cold) && !cold.Engine, "stop engine");
    cold.Engine = false; Check(!ToggleEngine(cold), "no engine start in D");
    auto run100 = [](bool boosted) {
        State s; s.Engine=true; s.Handbrake=false; s.Selector=Gear::D;
        int shifts=0, previous=1;
        for (int i=0; i<60*45; ++i) {
            Step(s,{true,false,boosted,0});
            if (s.AutoGear!=previous) { ++shifts; previous=s.AutoGear; }
            if (s.Speed*3.6>=100) {
                Check(shifts>=2,"D actually shifts under acceleration");
                return (i+1)*Dt;
            }
        }
        return 45.0;
    };
    const double normal100=run100(false), boost100=run100(true);
    Check(boost100>10 && boost100<12 && normal100>boost100*1.5 && normal100<40,"nonlinear calibrated-range acceleration");
    std::cout << "0-100 ordinary=" << normal100 << "s Shift=" << boost100 << "s\n";
    State shift; shift.Engine=true; shift.Handbrake=false; shift.Selector=Gear::D;
    shift.Speed=46/3.6; shift.Pedal=1; shift.Throttle=1; shift.Rpm=6100;
    Step(shift,{true,false,true,0});
    Check(shift.AutoGear==2 && shift.ShiftTimer>0 && shift.Rpm<6100,"shift unloads drive and lowers RPM");
    Check(EngineAccel(0.6,2,15,true,false,0)>EngineAccel(0.6,3,15,true,false,0),"different tractive effort by gear");
    Check(EngineAccel(1,1,48/3.6,true,false,0)==0,"M1 rev limiter");
    Check(RoadDrag(15,0,2,true)>RoadDrag(15,0,0,true),"engine braking versus N");
    State limit; limit.Engine=true; limit.Handbrake=false; limit.Selector=Gear::D;
    for (int i=0;i<120;++i) Step(limit,{true,false,false,0,false,0.2});
    Check(std::abs(limit.Pedal-0.2)<1e-12,"adjustable keyboard pedal limit");
    State overspeed; overspeed.Engine=true; overspeed.Selector=Gear::D; overspeed.Speed=25;
    Check(!Select(overspeed,Gear::M1,false),"manual downshift overrev protection");
    State freeRpm; freeRpm.Engine=true; freeRpm.Selector=Gear::N;
    for(int i=0;i<120;++i) Step(freeRpm,{true,false,false,0});
    Check(freeRpm.Rpm>3000 && freeRpm.Speed==0,"N free rev no wheel torque");
    for(int i=0;i<60;++i) Step(freeRpm,{});
    Check(freeRpm.Rpm<1100 && freeRpm.Throttle==0,"RPM and throttle release");
    State hydraulic; hydraulic.Engine=true; hydraulic.Selector=Gear::D;
    Step(hydraulic,{true,true,false,0});
    Check(hydraulic.BrakePressure>0 && hydraulic.BrakePressure<0.1 && hydraulic.Throttle==0,"hydraulic buildup and brake override");
    std::cout << "PASS UEDev session flow + model: cold start, selector, gas, neutral, braking, coordinates\n";
    return 0;
}
