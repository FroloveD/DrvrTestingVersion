/**
 * @module UEDev/SessionFlow
 * @layer pure-core-cpp
 * @role Разрешённые переходы меню/заезд/пауза/итог без зависимости от UE.
 * @invariants Только Driving разрешает симуляцию; меню не запускает заезд автоматически.
 * @tests ue/UEDev/Tests/DrivingModelTest.cpp.
 */
#pragma once
namespace uedev {
enum class Screen { Menu, Driving, Paused, Summary };
enum class Action { Start, Pause, Resume, Restart, Finish, Home };
struct SessionFlow {
    Screen Current = Screen::Menu;
    bool Apply(Action action) {
        switch (action) {
        case Action::Start:
            if (Current != Screen::Menu) return false;
            Current = Screen::Driving; return true;
        case Action::Pause:
            if (Current != Screen::Driving) return false;
            Current = Screen::Paused; return true;
        case Action::Resume:
            if (Current != Screen::Paused) return false;
            Current = Screen::Driving; return true;
        case Action::Restart:
            if (Current != Screen::Paused && Current != Screen::Summary) return false;
            Current = Screen::Driving; return true;
        case Action::Finish:
            if (Current != Screen::Paused) return false;
            Current = Screen::Summary; return true;
        case Action::Home:
            if (Current == Screen::Driving || Current == Screen::Menu) return false;
            Current = Screen::Menu; return true;
        }
        return false;
    }
    bool CanDrive() const { return Current == Screen::Driving; }
};
}
