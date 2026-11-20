/**
 * @module UEDev/PlayerController
 * @layer ue-ui
 * @role Slate-меню, пауза, итог и изоляция игрового ввода; без бинарных Widget-ассетов.
 * @invariants Pawn тикает и принимает ввод только в Driving; UI принадлежит UE, не вебу.
 * @tests SessionFlow переносимо; фокус/Slate/Play проверяются руками по ue/README.md.
 */
#pragma once
#include "CoreMinimal.h"
#include "GameFramework/PlayerController.h"
#include "SessionFlow.h"
#include "UEDevPlayerController.generated.h"
class SWidget;
UCLASS()
class UEDEV_API AUEDevPlayerController : public APlayerController {
    GENERATED_BODY()
public:
    virtual void BeginPlay() override;
    virtual void EndPlay(const EEndPlayReason::Type Reason) override;
    virtual void OnPossess(APawn* InPawn) override;
    virtual void SetupInputComponent() override;
    void SavePreferences();
    bool IsDriving() const { return Flow.CanDrive(); }
private:
    uedev::SessionFlow Flow;
    TSharedPtr<SWidget> ScreenWidget;
    FString Section = TEXT("Заезд");
    FString Result;
    int32 SelectedRoute = 0;
    double GasSetting = 0.6;
    bool PreferencesLoaded = false;
    TArray<FString> RecentResults;
    void LoadPreferences();
    void Escape();
    void Apply(uedev::Action Action);
    void SyncScreen();
    void RemoveScreen();
};
