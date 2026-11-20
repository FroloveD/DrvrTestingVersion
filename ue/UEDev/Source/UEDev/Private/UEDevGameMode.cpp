#include "UEDevGameMode.h"
#include "UEDevPawn.h"
#include "UEDevPlayerController.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/DirectionalLight.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/World.h"
#include "DrawDebugHelpers.h"
#include "GameFramework/PlayerController.h"
AUEDevGameMode::AUEDevGameMode() {
    PlayerControllerClass = AUEDevPlayerController::StaticClass();
    DefaultPawnClass = AUEDevPawn::StaticClass();
    HUDClass = AUEDevHUD::StaticClass();
}
void AUEDevGameMode::BeginPlay() {
    Super::BeginPlay();
    UWorld* World = GetWorld();
    UStaticMesh* Cube = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
    auto Box = [&](FVector Position, FVector Scale) {
        auto* Actor = World->SpawnActor<AStaticMeshActor>(Position, FRotator::ZeroRotator);
        if (!Actor) return;
        Actor->GetStaticMeshComponent()->SetMobility(EComponentMobility::Movable);
        Actor->GetStaticMeshComponent()->SetStaticMesh(Cube);
        Actor->SetActorScale3D(Scale);
        Actor->GetStaticMeshComponent()->SetCollisionProfileName(TEXT("BlockAll"));
    };
    Box(FVector(0, 0, -25), FVector(120, 80, 0.5));
    Box(FVector(6000, 0, 100), FVector(0.3, 80, 2));
    Box(FVector(-6000, 0, 100), FVector(0.3, 80, 2));
    Box(FVector(0, 4000, 100), FVector(120, 0.3, 2));
    Box(FVector(0, -4000, 100), FVector(120, 0.3, 2));
    // Произвольные ориентиры, не нормативные парковочные места.
    for (int Index = 0; Index < 5; ++Index) {
        Box(FVector(1500 + Index * 700, 1200, 50), FVector(0.5, 0.5, 1));
    }
    for (int Index = -5; Index <= 5; ++Index) {
        DrawDebugLine(World, FVector(-5500, Index * 600, 2), FVector(5500, Index * 600, 2), FColor::Gray, true, -1, 0, 3);
    }
    World->SpawnActor<ADirectionalLight>(FVector(0, 0, 1500), FRotator(-55, -30, 0));
    // Нет PlayerStart-ассета: машину ставим вручную над плоскостью.
    if (auto* PC = World->GetFirstPlayerController()) {
        if (auto* Pawn = Cast<AUEDevPawn>(PC->GetPawn())) Pawn->SetActorLocation(FVector(0, 0, 71));
    }
}
void AUEDevHUD::DrawHUD() {
    Super::DrawHUD();
    const auto* PC = GetOwningPlayerController();
    const auto* Session = Cast<AUEDevPlayerController>(PC);
    if (!Session || !Session->IsDriving()) return;
    const auto* Pawn = PC ? Cast<AUEDevPawn>(PC->GetPawn()) : nullptr;
    if (!Pawn) return;
    const auto& S = Pawn->GetDrivingState();
    DrawText(TEXT("UEDev — прототип, физика не откалибрована"), FLinearColor::Yellow, 24, 24);
    DrawText(FString::Printf(TEXT("%.1f км/ч | %s | ДВС %s | Ручник %s | Ремень %s | Газ %.0f%%"),
        FMath::Abs(S.Speed) * 3.6, UTF8_TO_TCHAR(uedev::Label(S.Selector)),
        S.Engine ? TEXT("ВКЛ") : TEXT("ВЫКЛ"), S.Handbrake ? TEXT("ВКЛ") : TEXT("ВЫКЛ"),
        S.Belt ? TEXT("ДА") : TEXT("НЕТ"), S.Pedal * 100), FLinearColor::White, 24, 50);
    DrawText(TEXT("Esc — пауза | Enter — быстрый старт | Backspace — холодный сброс"), FLinearColor::White, 24, 76);
    DrawText(TEXT("Учебная симуляция. Не официальный экзамен. © OpenStreetMap contributors (веб-версия)."), FLinearColor::White, 24, 104);
}
