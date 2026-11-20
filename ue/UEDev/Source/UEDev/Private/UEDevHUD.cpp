/**
 * @module UEDev/HUD
 * @layer ue-presentation
 * @role Информационные панели по логике v1: приборы, селектор, состояния, педали и маршрут.
 * @invariants Только чтение состояния; не перехватывает мышь, нет неработающих кнопок.
 * @tests HudModel в DrivingModelTest; размер/шрифты/контраст — ручной smoke UE.
 */
#include "UEDevGameMode.h"
#include "UEDevPawn.h"
#include "UEDevPlayerController.h"
#include "HudModel.h"
#include "Engine/Canvas.h"
#include "Engine/Engine.h"
#include "GameFramework/PlayerController.h"

void AUEDevHUD::DrawHUD() {
    Super::DrawHUD();
    const auto* PC = GetOwningPlayerController();
    const auto* Session = Cast<AUEDevPlayerController>(PC);
    const auto* DrivingPawn = PC ? Cast<AUEDevPawn>(PC->GetPawn()) : nullptr;
    if (!Canvas || !GEngine || !Session || !Session->IsDriving() || !DrivingPawn) return;
    const float Scale = static_cast<float>(uedev::HudScale(Canvas->ClipX, Canvas->ClipY));
    const float Width = Canvas->ClipX / Scale, Height = Canvas->ClipY / Scale;
    const FLinearColor Background(0.025f,0.04f,0.055f,0.94f);
    const FLinearColor Muted(0.59f,0.68f,0.74f), White(0.93f,0.96f,0.98f);
    const FLinearColor Green(0.32f,0.84f,0.74f), Amber(0.96f,0.73f,0.26f), Red(1.f,0.42f,0.42f);
    auto Rect = [&](float X,float Y,float W,float H,FLinearColor Color) {
        DrawRect(Color,X*Scale,Y*Scale,W*Scale,H*Scale);
    };
    auto Text = [&](const FString& Value,float X,float Y,FLinearColor Color,float Size=1.f,float MaxWidth=1200.f) {
        float TW=0, TH=0;
        GetTextSize(Value,TW,TH,GEngine->GetMediumFont(),Size);
        const float Fit = TW>MaxWidth ? MaxWidth/TW : 1.f;
        DrawText(Value,Color,X*Scale,Y*Scale,GEngine->GetMediumFont(),Size*Fit*Scale);
    };
    auto Panel = [&](float X,float Y,float W,float H) {
        Rect(X,Y,W,H,Background);
        Rect(X,Y,W,2,FLinearColor(0.17f,0.28f,0.33f));
    };
    // Дисклеймер остаётся виден и при скрытых приборах.
    Rect(0,Height-26,Width,26,Background);
    Text(TEXT("Учебный прототип · не официальный экзамен · © OpenStreetMap contributors (веб-версия)"),16,Height-21,Muted,0.78f,Width-180);
    Text(bShowHUD ? TEXT("H · скрыть HUD") : TEXT("H · показать HUD"),Width-150,Height-21,White,0.8f,138);
    if (!bShowHUD) return;

    const auto& S = DrivingPawn->GetDrivingState();
    const auto& Run = DrivingPawn->GetRouteRun();
    const auto& Route = DrivingPawn->GetRoute();
    const bool Done = Run.Done(Route);
    Panel(16,16,720,100);
    Text(Route.Id==1 ? TEXT("МАРШРУТ / ТЕСТОВАЯ ПРЯМАЯ 1 КМ") : TEXT("МАРШРУТ / ПЛОЩАДКА"),32,28,Muted,0.9f,680);
    const FString Objective = Done ? TEXT("Все контрольные точки пройдены") : FString::Printf(
        Route.Points[Run.Next].Stop ? TEXT("КТ %d из %d · остановитесь в жёлтой зоне") : TEXT("КТ %d из %d · проедьте зелёную зону"),Run.Next+1,Route.Count);
    Text(Objective,32,51,Done ? Green : White,1.22f,680);
    Text(Done ? TEXT("Esc → Завершить заезд и открыть итог") : FString::Printf(TEXT("До зоны: %.0f м по прямой · Пройдено КТ: %d/%d"),
        uedev::CheckpointDistance(S,Route,Run),Run.Next,Route.Count),32,83,Done ? Green : Muted,0.92f,680);
    Panel(Width-254,16,238,100);
    Text(TEXT("ТЕХНИЧЕСКИЙ ЗАЕЗД"),Width-238,28,Amber,0.88f,210);
    Text(FString::Printf(TEXT("%02d:%02d   /   %.0f м"),static_cast<int>(Run.Seconds)/60,static_cast<int>(Run.Seconds)%60,Run.Distance),Width-238,53,White,1.15f,210);
    Text(FString::Printf(TEXT("Максимум %.1f км/ч"),Run.MaxKmh),Width-238,83,Muted,0.9f,210);

    const float Bottom = Height-242;
    Panel(16,Bottom,330,168);
    Text(TEXT("СКОРОСТЬ"),32,Bottom+12,Muted,0.86f);
    Text(FString::Printf(TEXT("%.0f"),FMath::Abs(S.Speed)*3.6),30,Bottom+32,White,4.2f,180);
    Text(TEXT("км/ч"),206,Bottom+76,Muted,1.1f);
    const FLinearColor RpmColor = S.Rpm>=5500 ? Red : S.Rpm>=4400 ? Amber : Green;
    Rect(32,Bottom+119,298,6,FLinearColor(0.12f,0.18f,0.22f));
    Rect(32,Bottom+119,298*static_cast<float>(FMath::Clamp(S.Rpm/6500.0,0.0,1.0)),6,RpmColor);
    Text(S.Engine ? FString::Printf(uedev::Manual(S.Selector) && S.Selector!=uedev::Gear::M6 && S.Rpm>=5500 ? TEXT("%.0f об/мин · Shift+↑") : TEXT("%.0f об/мин"),S.Rpm) : TEXT("ДВИГАТЕЛЬ ЗАГЛУШЕН"),32,Bottom+138,S.Engine ? RpmColor : Red,0.95f,290);

    Panel(358,Bottom,458,168);
    Text(TEXT("КОРОБКА ПЕРЕДАЧ"),374,Bottom+12,Muted,0.86f);
    const bool Forward = S.Selector==uedev::Gear::D || uedev::Manual(S.Selector);
    for (int Index=0;Index<4;++Index) {
        const bool Active = Index==0 ? S.Selector==uedev::Gear::P : Index==1 ? S.Selector==uedev::Gear::R : Index==2 ? S.Selector==uedev::Gear::N : Forward;
        const float X=374+Index*106.f;
        Rect(X,Bottom+38,96,46,Active ? (Index==1 ? Amber : Green) : FLinearColor(0.09f,0.14f,0.18f));
        FString GearLabel = Index==0 ? TEXT("P") : Index==1 ? TEXT("R") : Index==2 ? TEXT("N") : TEXT("D");
        if (Index==3 && Forward) GearLabel=S.Selector==uedev::Gear::D ? FString::Printf(TEXT("D%d"),S.AutoGear) : FString(UTF8_TO_TCHAR(uedev::Label(S.Selector)));
        Text(GearLabel,X+15,Bottom+47,Active ? FLinearColor(0.02f,0.06f,0.07f) : Muted,1.6f,72);
    }
    Text(TEXT("P [P]       R [R]       N [N]       D [F]"),374,Bottom+91,Muted,0.8f,420);
    auto Status = [&](const TCHAR* Name,const TCHAR* Value,float X,FLinearColor Color) {
        Text(Name,X,Bottom+117,Muted,0.76f,100);
        Text(Value,X,Bottom+137,Color,0.92f,100);
    };
    Status(TEXT("ДВС [I]"),S.Engine ? TEXT("РАБОТАЕТ") : TEXT("ВЫКЛ"),374,S.Engine ? Green : Red);
    Status(TEXT("РУЧНИК [Space]"),S.Handbrake ? TEXT("ЗАТЯНУТ") : TEXT("СНЯТ"),480,S.Handbrake ? Red : Green);
    Status(TEXT("РЕМЕНЬ [B]"),S.Belt ? TEXT("ПРИСТЁГНУТ") : TEXT("НЕ НАДЕТ"),586,S.Belt ? Green : Amber);
    Status(TEXT("ФАРЫ [L]"),DrivingPawn->AreHeadlightsOn() ? TEXT("ВКЛ") : TEXT("ВЫКЛ"),692,DrivingPawn->AreHeadlightsOn() ? Green : Muted);

    Panel(Width-448,Bottom,432,168);
    Text(TEXT("ПЕДАЛИ / ГАЗ И ТОРМОЗ"),Width-432,Bottom+12,Muted,0.86f,400);
    auto Pedal = [&](const TCHAR* Name,float Y,double Value,FLinearColor Color) {
        const float X=Width-432;
        Text(Name,X,Y,White,0.95f,130);
        Rect(X+140,Y+3,190,14,FLinearColor(0.12f,0.18f,0.22f));
        Rect(X+140,Y+3,190*static_cast<float>(FMath::Clamp(Value,0.0,1.0)),14,Color);
        Text(FString::Printf(TEXT("%.0f%%"),Value*100),X+342,Y,Color,0.95f,58);
    };
    Pedal(TEXT("ТОРМОЗ [S]"),Bottom+45,S.BrakePressure,Red);
    Pedal(TEXT("ГАЗ [W]"),Bottom+79,S.Throttle,Green);
    Text(FString::Printf(TEXT("Обычный газ %.0f%% · Ctrl+колесо"),DrivingPawn->GetOrdinaryGas()*100),Width-432,Bottom+116,Muted,0.88f,400);
    Text(TEXT("Shift+W · полный газ в D/M"),Width-432,Bottom+139,Muted,0.88f,400);

    Panel(16,Height-64,Width-32,30);
    FString Hint;
    switch (uedev::NextHint(S,Done)) {
        case uedev::HudHint::StartEngine: Hint=TEXT("Запустите ДВС: I · или S+Enter — подготовка без сброса"); break;
        case uedev::HudHint::ParkOrNeutral: Hint=TEXT("Для запуска ДВС остановитесь и выберите P или N"); break;
        case uedev::HudHint::Belt: Hint=TEXT("Пристегните ремень: B"); break;
        case uedev::HudHint::Handbrake: Hint=TEXT("Снимите ручник: Space (удерживайте S)"); break;
        case uedev::HudHint::LeavePark: Hint=TEXT("Удерживайте S и выберите D клавишей F"); break;
        case uedev::HudHint::LeaveNeutral: Hint=TEXT("Селектор в N · F — вперёд, R — назад"); break;
        case uedev::HudHint::Finished: Hint=TEXT("Маршрут пройден · Esc → Завершить"); break;
        default: Hint=TEXT("W/S — газ/тормоз · A/D или ЛКМ — руль · ПКМ — камера"); break;
    }
    Text(Hint,30,Height-58,Amber,0.88f,Width-430);
    Text(TEXT("Esc · пауза   Backspace · сброс"),Width-376,Height-58,Muted,0.88f,340);
}
