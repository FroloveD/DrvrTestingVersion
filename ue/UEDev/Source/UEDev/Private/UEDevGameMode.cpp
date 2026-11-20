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
    GetWorld()->SpawnActor<ADirectionalLight>(FVector(0, 0, 1500), FRotator(-55, -30, 0));
    BuildRoute(0);
}
void AUEDevGameMode::BuildRoute(int Id) {
    UWorld* World = GetWorld();
    for (const auto& Actor : RouteActors) if (IsValid(Actor.Get())) Actor->Destroy();
    RouteActors.Empty();
    FlushPersistentDebugLines(World);
    const auto Route = uedev::Route(Id);
    UStaticMesh* Cube = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
    auto Box = [&](FVector Position, FVector Scale) {
        auto* Actor = World->SpawnActor<AStaticMeshActor>(Position, FRotator::ZeroRotator);
        if (!Actor) return;
        RouteActors.Add(Actor);
        Actor->GetStaticMeshComponent()->SetMobility(EComponentMobility::Movable);
        Actor->GetStaticMeshComponent()->SetStaticMesh(Cube);
        Actor->SetActorScale3D(Scale);
        Actor->GetStaticMeshComponent()->SetCollisionProfileName(TEXT("BlockAll"));
    };
    const double Forward=Route.HalfForward, Side=Route.HalfSide;
    Box(FVector(0,0,-25),FVector(Forward*2,Side*2,0.5));
    Box(FVector(Forward*100,0,100),FVector(0.3,Side*2,2));
    Box(FVector(-Forward*100,0,100),FVector(0.3,Side*2,2));
    Box(FVector(0,Side*100,100),FVector(Forward*2,0.3,2));
    Box(FVector(0,-Side*100,100),FVector(Forward*2,0.3,2));
    if (Id==0) for (int Index=0;Index<5;++Index) Box(FVector(1500+Index*700,1200,50),FVector(0.5,0.5,1));
    for (int Index=0;Index<Route.Count;++Index) {
        const auto& Point=Route.Points[Index];
        const FVector Center(Point.Z*100,-Point.X*100,5);
        const FColor Color=Point.Stop ? FColor::Yellow : FColor::Green;
        DrawDebugCircle(World,Center,Point.Radius*100,64,Color,true,-1,0,5,FVector(1,0,0),FVector(0,1,0),false);
        // Ворота по краям КТ остаются видны даже если debug drawing отключён.
        Box(Center+FVector(0,-Point.Radius*100,95),FVector(0.3,0.3,2));
        Box(Center+FVector(0,Point.Radius*100,95),FVector(0.3,0.3,2));
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
    const FString GearText = S.Selector == uedev::Gear::D
        ? FString::Printf(TEXT("D%d"), S.AutoGear) : FString(UTF8_TO_TCHAR(uedev::Label(S.Selector)));
    DrawText(TEXT("UEDev — прототип, физика не откалибрована"), FLinearColor::Yellow, 24, 24);
    DrawText(FString::Printf(TEXT("%.1f км/ч | %s | %.0f об/мин | ДВС %s | Ручник %s | Ремень %s | Газ %.0f%% | Тормоз %.0f%%"),
        FMath::Abs(S.Speed) * 3.6, *GearText, S.Rpm,
        S.Engine ? TEXT("ВКЛ") : TEXT("ВЫКЛ"), S.Handbrake ? TEXT("ВКЛ") : TEXT("ВЫКЛ"),
        S.Belt ? TEXT("ДА") : TEXT("НЕТ"), S.Throttle * 100, S.BrakePressure * 100), FLinearColor::White, 24, 50);
    DrawText(FString::Printf(TEXT("Обычный газ: %.0f%% · Ctrl+колесо: 10–60%% · Shift+W в D/M: полный газ"),
        Pawn->GetOrdinaryGas() * 100), FLinearColor::White, 24, 76);
    DrawText(TEXT("Esc — пауза | Enter — быстрый старт | Backspace — холодный сброс"), FLinearColor::White, 24, 102);
    const auto& Run=Pawn->GetRouteRun();
    const auto& Route=Pawn->GetRoute();
    DrawText(FString::Printf(TEXT("КТ %d/%d | %.1f с | %.0f м | %s"),Run.Next,Route.Count,Run.Seconds,Run.Distance,
        Run.Done(Route) ? TEXT("Маршрут пройден. Esc → завершить") :
        Route.Points[Run.Next].Stop ? TEXT("Остановитесь в жёлтом круге") : TEXT("Пройдите следующую зелёную КТ")),FLinearColor::Yellow,24,128);
    DrawText(TEXT("Учебная симуляция. Не официальный экзамен. © OpenStreetMap contributors (веб-версия)."), FLinearColor::White, 24, 154);
}
