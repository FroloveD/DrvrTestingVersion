#include "DrivingModel.h"
#include "SessionFlow.h"
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
    std::cout << "PASS UEDev session flow + model: cold start, selector, gas, neutral, braking, coordinates\n";
    return 0;
}
