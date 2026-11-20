/**
 * @module UEDev/GameMode
 * @layer ue-shell
 * @role Процедурная тестовая площадка и текстовый HUD без внешних ассетов и .umap.
 * @invariants Только учебный стенд; не нормативный бокс и не экзаменационная оценка.
 * @tests Ручной smoke в ue/README.md.
 */
#pragma once
#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "GameFramework/HUD.h"
#include "UEDevGameMode.generated.h"
UCLASS()
class UEDEV_API AUEDevHUD : public AHUD {
    GENERATED_BODY()
public:
    virtual void DrawHUD() override;
};
UCLASS()
class UEDEV_API AUEDevGameMode : public AGameModeBase {
    GENERATED_BODY()
public:
    AUEDevGameMode();
    virtual void BeginPlay() override;
    void BuildRoute(int Id);
private:
    UPROPERTY() TArray<TObjectPtr<AActor>> RouteActors;
};
