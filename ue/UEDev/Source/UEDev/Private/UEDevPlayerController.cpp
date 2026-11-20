#include "UEDevPlayerController.h"
#include "UEDevPawn.h"
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
void AUEDevPlayerController::BeginPlay() { Super::BeginPlay(); SyncScreen(); }
void AUEDevPlayerController::OnPossess(APawn* InPawn) {
    Super::OnPossess(InPawn);
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
    if (auto* Pawn = Cast<AUEDevPawn>(GetPawn())) {
        if (Action == uedev::Action::Start || Action == uedev::Action::Restart) Pawn->ResetRide();
        if (Action == uedev::Action::Finish) {
            const auto& State = Pawn->GetDrivingState();
            Result = FString::Printf(TEXT("Заезд завершён вручную. Последняя скорость: %.1f км/ч, КПП: %s.\nОценка, запись и журнал пока не перенесены. Это не экзаменационный протокол."),
                FMath::Abs(State.Speed) * 3.6, UTF8_TO_TCHAR(uedev::Label(State.Selector)));
        }
        // Возврат в меню отбрасывает текущий стендовый заезд, журнал пока отсутствует.
        if (Action == uedev::Action::Home) Pawn->ResetRide();
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
    if (auto* Pawn = Cast<AUEDevPawn>(GetPawn())) {
        Pawn->SetActorTickEnabled(Driving);
        Pawn->SetActorHiddenInGame(Flow.Current == uedev::Screen::Menu);
        if (Driving) Pawn->EnableInput(this); else Pawn->DisableInput(this);
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
        Button(TEXT("Начать заезд — тестовая площадка"), [this]() { Apply(uedev::Action::Start); });
        for (const FString Name : {FString(TEXT("Маршруты")), FString(TEXT("Автомобиль")), FString(TEXT("Настройки и управление")), FString(TEXT("Журнал и разбор"))}) {
            Button(Name, [this, Name]() { Section = Name; SyncScreen(); });
        }
        Text(Section);
        if (Section == TEXT("Маршруты"))
            Text(TEXT("Доступна только процедурная тестовая площадка 120×80 м. Создание маршрутов, редактор и импорт OSM ещё не перенесены. Они будут размещены здесь, вне экрана вождения."));
        else if (Section == TEXT("Автомобиль"))
            Text(TEXT("Одна машина-заглушка 4,31×1,80 м. Выбор моделей и салон ещё не перенесены."));
        else if (Section == TEXT("Настройки и управление"))
            Text(TEXT("W/S — газ/тормоз; A/D — руль; Shift+W — полный газ в D/M.\nI — двигатель; Space — ручник; B — ремень; P/R/N/F — селектор.\nЛКМ+мышь — руль; ПКМ+мышь — камера; колесо — зум.\nEnter — быстрый старт в заезде; Backspace — холодный сброс; Esc — пауза.\nПереназначение, графические настройки и оборудование пока недоступны."));
        else if (Section == TEXT("Журнал и разбор"))
            Text(TEXT("Запись, сохранение и реплей ещё не перенесены. Возврат в меню отбрасывает текущий заезд."));
        else Text(TEXT("Начало заезда — холодный старт: P, двигатель выключен, ручник затянут. Enter в сцене — быстрый старт."));
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
        SNew(SScrollBox) + SScrollBox::Slot()[Items]
    ];
    GetWorld()->GetGameViewport()->AddViewportWidgetContent(ScreenWidget.ToSharedRef(), 100);
    FInputModeGameAndUI Mode;
    Mode.SetWidgetToFocus(FirstButton);
    Mode.SetHideCursorDuringCapture(false);
    Mode.SetLockMouseToViewportBehavior(EMouseLockMode::DoNotLock);
    SetInputMode(Mode);
}
