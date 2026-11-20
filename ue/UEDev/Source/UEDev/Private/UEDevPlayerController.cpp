#include "UEDevPlayerController.h"
#include "UEDevPawn.h"
#include "UEDevGameMode.h"
#include "Misc/ConfigCacheIni.h"
#include "Components/InputComponent.h"
#include "Engine/GameViewportClient.h"
#include "Engine/World.h"
#include "InputCoreTypes.h"
#include "Widgets/SBoxPanel.h"
#include "Styling/CoreStyle.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Input/SSlider.h"
#include "Widgets/Layout/SBox.h"
void AUEDevPlayerController::LoadPreferences() {
    if (PreferencesLoaded) return;
    PreferencesLoaded = true;
    if (GConfig) {
        GConfig->GetInt(TEXT("UEDev"),TEXT("SelectedRoute"),SelectedRoute,GGameUserSettingsIni);
        GConfig->GetDouble(TEXT("UEDev"),TEXT("OrdinaryGas"),GasSetting,GGameUserSettingsIni);
        GConfig->GetDouble(TEXT("UEDev"),TEXT("HeadReturnRate"),HeadReturnSetting,GGameUserSettingsIni);
    }
    SelectedRoute = FMath::Clamp(SelectedRoute,0,1);
    GasSetting = uedev::OrdinaryGasLimit(GasSetting);
    HeadReturnSetting = uedev::HeadReturnRate(HeadReturnSetting);
}
void AUEDevPlayerController::SavePreferences() {
    if (const auto* DrivingPawn = Cast<AUEDevPawn>(GetPawn())) {
        GasSetting=DrivingPawn->GetOrdinaryGas();
        HeadReturnSetting=DrivingPawn->GetHeadReturnRate();
    }
    if (!GConfig) return;
    GConfig->SetInt(TEXT("UEDev"),TEXT("SelectedRoute"),SelectedRoute,GGameUserSettingsIni);
    GConfig->SetDouble(TEXT("UEDev"),TEXT("OrdinaryGas"),GasSetting,GGameUserSettingsIni);
    GConfig->SetDouble(TEXT("UEDev"),TEXT("HeadReturnRate"),HeadReturnSetting,GGameUserSettingsIni);
    GConfig->Flush(false,GGameUserSettingsIni);
}
void AUEDevPlayerController::BeginPlay() { Super::BeginPlay(); LoadPreferences(); SyncScreen(); }
void AUEDevPlayerController::OnPossess(APawn* InPawn) {
    Super::OnPossess(InPawn);
    LoadPreferences();
    if (auto* DrivingPawn=Cast<AUEDevPawn>(InPawn)) {
        DrivingPawn->SetOrdinaryGas(GasSetting);
        DrivingPawn->SetHeadReturnRate(HeadReturnSetting);
    }
    SyncScreen();
}
void AUEDevPlayerController::EndPlay(const EEndPlayReason::Type Reason) {
    RemoveScreen(); Super::EndPlay(Reason);
}
void AUEDevPlayerController::SetupInputComponent() {
    Super::SetupInputComponent();
    InputComponent->BindKey(EKeys::Escape, IE_Pressed, this, &AUEDevPlayerController::Escape);
}
void AUEDevPlayerController::Escape() {
    if (Flow.Current == uedev::Screen::Driving) Apply(uedev::Action::Pause);
    else if (Flow.Current == uedev::Screen::Paused) Apply(uedev::Action::Resume);
}
void AUEDevPlayerController::Apply(uedev::Action Action) {
    if (!Flow.Apply(Action)) return;
    if (auto* DrivingPawn = Cast<AUEDevPawn>(GetPawn())) {
        if (Action == uedev::Action::Start) {
            if (auto* Mode=GetWorld()->GetAuthGameMode<AUEDevGameMode>()) Mode->BuildRoute(SelectedRoute);
            DrivingPawn->SetRoute(SelectedRoute);
        }
        if (Action == uedev::Action::Restart) DrivingPawn->ResetRide();
        if (Action == uedev::Action::Finish) {
            const auto& State = DrivingPawn->GetDrivingState();
            const auto& Run=DrivingPawn->GetRouteRun();
            const auto& Route=DrivingPawn->GetRoute();
            Result = FString::Printf(TEXT("%s · КТ %d/%d · %.1f с · %.0f м · максимум %.1f км/ч. %s"),
                Route.Id==1 ? TEXT("Прямая 1 км") : TEXT("Площадка"),Run.Next,Route.Count,Run.Seconds,Run.Distance,Run.MaxKmh,
                Run.Done(Route) ? TEXT("Все КТ пройдены.") : TEXT("Завершено до прохождения всех КТ."));
            RecentResults.Insert(Result,0);
            if (RecentResults.Num()>10) RecentResults.SetNum(10);
            Result += FString::Printf(TEXT("\nПоследняя скорость: %.1f км/ч, КПП: %s. Это технический итог, не экзаменационная оценка. Реплей не записывается."),
                FMath::Abs(State.Speed)*3.6,UTF8_TO_TCHAR(uedev::Label(State.Selector)));
        }
        // Возврат в меню отбрасывает текущий стендовый заезд, журнал пока отсутствует.
        if (Action == uedev::Action::Home) DrivingPawn->ResetRide();
    }
    Section = TEXT("Заезд");
    SyncScreen();
}
void AUEDevPlayerController::RemoveScreen() {
    if (ScreenWidget.IsValid()) {
        if (GetWorld() && GetWorld()->GetGameViewport()) GetWorld()->GetGameViewport()->RemoveViewportWidgetContent(ScreenWidget.ToSharedRef());
        ScreenWidget.Reset();
    }
}
void AUEDevPlayerController::SyncScreen() {
    RemoveScreen();
    FlushPressedKeys();
    const bool Driving = Flow.CanDrive();
    if (auto* DrivingPawn = Cast<AUEDevPawn>(GetPawn())) {
        DrivingPawn->SetActorTickEnabled(Driving);
        DrivingPawn->SetActorHiddenInGame(Flow.Current == uedev::Screen::Menu);
        if (Driving) DrivingPawn->EnableInput(this); else DrivingPawn->DisableInput(this);
    }
    bShowMouseCursor = !Driving;
    if (Driving) {
        FInputModeGameOnly Mode;
        Mode.SetConsumeCaptureMouseDown(true);
        SetInputMode(Mode);
        return;
    }
    if (!IsLocalController() || !GetWorld() || !GetWorld()->GetGameViewport()) return;
    TSharedRef<SVerticalBox> Items = SNew(SVerticalBox);
    auto Text = [&](const FString& Value) {
        Items->AddSlot().AutoHeight().Padding(0, 8)[SNew(STextBlock).Text(FText::FromString(Value)).AutoWrapText(true)];
    };
    TSharedPtr<SWidget> FirstButton;
    auto Button = [&](const FString& Label, TFunction<void()> Run) {
        TSharedRef<SButton> Widget = SNew(SButton)
            .Text(FText::FromString(Label))
            .OnClicked_Lambda([Run]() { Run(); return FReply::Handled(); });
        Items->AddSlot().AutoHeight().Padding(0, 5)[Widget];
        if (!FirstButton.IsValid()) FirstButton = Widget;
    };
    if (Flow.Current == uedev::Screen::Menu) {
        Text(TEXT("UEDev — стартовый экран"));
        Text(TEXT("Клавиатура и мышь · технический прототип · физика не откалибрована"));
        Text(SelectedRoute==1 ? TEXT("Выбрано: тестовая прямая 1 км · 4 КТ · остановка в конце") : TEXT("Выбрано: площадка 120×80 м · 2 КТ · остановка в конце"));
        Button(TEXT("Начать выбранный заезд"), [this]() { Apply(uedev::Action::Start); });
        for (const FString Name : {FString(TEXT("Заезд")),FString(TEXT("Маршруты")), FString(TEXT("Автомобиль")), FString(TEXT("Настройки и управление")), FString(TEXT("Журнал и разбор"))}) {
            Button(Name, [this, Name]() { Section = Name; SyncScreen(); });
        }
        Text(Section);
        if (Section == TEXT("Маршруты")) {
            Button(TEXT("Выбрать площадку 120×80 м"), [this]() { SelectedRoute=0; SavePreferences(); SyncScreen(); });
            Button(TEXT("Выбрать тестовую прямую 1 км"), [this]() { SelectedRoute=1; SavePreferences(); SyncScreen(); });
            Text(TEXT("Зелёные КТ проходятся по порядку; в последнем жёлтом круге нужна остановка. Прямая — технический стенд динамики, не новое экзаменационное упражнение. Создание маршрутов и импорт OSM ещё не перенесены."));
        } else if (Section == TEXT("Автомобиль")) {
            Text(TEXT("Ceed: геометрия 4,31×1,80 м, продольная модель 6АКПП, визуальная заглушка. Других моделей/салона пока нет."));
        } else if (Section == TEXT("Настройки и управление")) {
            Text(TEXT("Уровень обычного газа (10–60 %). Меняет тягу по W; Shift+W в D/M — 100 %."));
            Items->AddSlot().AutoHeight().Padding(0,10)[SNew(SSlider)
                .Value(static_cast<float>((GasSetting-0.1)/0.5))
                .OnValueChanged_Lambda([this](float Value) {
                    GasSetting=uedev::OrdinaryGasLimit(0.1+Value*0.5);
                    if (auto* DrivingPawn=Cast<AUEDevPawn>(GetPawn())) DrivingPawn->SetOrdinaryGas(GasSetting);
                })];
            Items->AddSlot().AutoHeight()[SNew(STextBlock).Text_Lambda([this]() {
                return FText::FromString(FString::Printf(TEXT("Обычный газ: %.0f %%"),GasSetting*100));
            })];
            Text(TEXT("Возврат взгляда после отпускания стрелки: быстро — очень быстро (540–900°/с). Без сглаживания и медленного доворота."));
            Items->AddSlot().AutoHeight().Padding(0,10)[SNew(SSlider)
                .Value(static_cast<float>((HeadReturnSetting-540)/360))
                .OnValueChanged_Lambda([this](float Value) {
                    HeadReturnSetting=uedev::HeadReturnRate(540+Value*360);
                    if (auto* DrivingPawn=Cast<AUEDevPawn>(GetPawn())) DrivingPawn->SetHeadReturnRate(HeadReturnSetting);
                })];
            Items->AddSlot().AutoHeight()[SNew(STextBlock).Text_Lambda([this]() {
                return FText::FromString(FString::Printf(TEXT("Возврат: %.0f°/с · от крайнего взгляда около %.2f с"),HeadReturnSetting,110/HeadReturnSetting));
            })];
            Button(TEXT("Возврат по умолчанию — 720°/с"),[this]() {
                HeadReturnSetting=720;
                if (auto* DrivingPawn=Cast<AUEDevPawn>(GetPawn())) DrivingPawn->SetHeadReturnRate(HeadReturnSetting);
                SavePreferences(); SyncScreen();
            });
            Button(TEXT("Сохранить настройки"),[this]() { SavePreferences(); });
            Button(TEXT("Газ по умолчанию — 60 %"),[this]() {
                GasSetting=0.6;
                if (auto* DrivingPawn=Cast<AUEDevPawn>(GetPawn())) DrivingPawn->SetOrdinaryGas(GasSetting);
                SavePreferences(); SyncScreen();
            });
            Text(TEXT("W/S — газ/тормоз; A/D — руль; Ctrl+колесо — уровень газа с сохранением.\nI — двигатель; Space — ручник; B — ремень; P/R/N/F — селектор; Shift+↑/↓ — M.\nЛКМ+мышь — руль; ПКМ+мышь — камера/взгляд; колесо — зум/FOV. C — смена вида; 1 — сзади; 2 — салон и взгляд вперёд. ←/→ — взгляд в салоне; ↑/↓ — только коробка. F5/F6/F7 — заднее/левое/правое зеркало.\nS+Enter — подготовка без сброса; L — фары; H — скрыть/показать HUD; Backspace — холодный сброс; Esc — пауза.\nПереназначение клавиш и графические настройки ещё не перенесены."));
        } else if (Section == TEXT("Журнал и разбор")) {
            Text(TEXT("Последние 10 завершённых заездов этой сессии. После закрытия приложения список очищается. Оценка/реплей/постоянный журнал ещё не перенесены."));
            if (RecentResults.IsEmpty()) Text(TEXT("Завершённых заездов пока нет."));
            for (const FString& Entry : RecentResults) Text(Entry);
        } else {
            Text(TEXT("Старт — P, двигатель выключен, ручник затянут. Ручной запуск: I → удерживать S → F → отпустить S → Space → B → W. S+Enter подготавливает машину без сброса позиции/КТ; на ходу не действует. L — фары. Остановитесь в последней КТ, затем Esc → Завершить."));
        }
    } else if (Flow.Current == uedev::Screen::Paused) {
        Text(TEXT("Пауза — движение и игровой ввод остановлены"));
        Button(TEXT("Продолжить (Esc)"), [this]() { Apply(uedev::Action::Resume); });
        Button(TEXT("Начать заново — холодный старт"), [this]() { Apply(uedev::Action::Restart); });
        Button(TEXT("Завершить заезд"), [this]() { Apply(uedev::Action::Finish); });
        Button(TEXT("На стартовый экран — без сохранения"), [this]() { Apply(uedev::Action::Home); });
    } else {
        Text(TEXT("Итог заезда")); Text(Result);
        Button(TEXT("Новый заезд — холодный старт"), [this]() { Apply(uedev::Action::Restart); });
        Button(TEXT("На стартовый экран"), [this]() { Apply(uedev::Action::Home); });
    }
    Text(TEXT("Учебная симуляция. Не официальный экзамен. Данные карт веб-версии: © OpenStreetMap contributors."));
    ScreenWidget = SNew(SBorder).BorderImage(FCoreStyle::Get().GetBrush("WhiteBrush")).Padding(40).BorderBackgroundColor(FLinearColor(0.015f, 0.025f, 0.04f, 1.f))[
        SNew(SVerticalBox) + SVerticalBox::Slot().HAlign(HAlign_Center).VAlign(VAlign_Fill)[
            SNew(SBox).MaxDesiredWidth(860)[SNew(SScrollBox) + SScrollBox::Slot()[Items]]
        ]
    ];
    GetWorld()->GetGameViewport()->AddViewportWidgetContent(ScreenWidget.ToSharedRef(), 100);
    FInputModeGameAndUI Mode;
    Mode.SetWidgetToFocus(FirstButton);
    Mode.SetHideCursorDuringCapture(false);
    Mode.SetLockMouseToViewportBehavior(EMouseLockMode::DoNotLock);
    SetInputMode(Mode);
}
