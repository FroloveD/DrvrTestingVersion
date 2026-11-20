#include "UEDevGameMode.h"
#include "UEDevPawn.h"
#include "UEDevPlayerController.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/DirectionalLight.h"
#include "Engine/SkyLight.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/SkyLightComponent.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
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
    // Компонент не требует отдельного заголовка актора ASkyAtmosphere.
    if (auto* AtmosphereActor = GetWorld()->SpawnActor<AActor>()) {
        auto* Atmosphere = NewObject<USkyAtmosphereComponent>(AtmosphereActor, TEXT("DayAtmosphere"));
        AtmosphereActor->AddInstanceComponent(Atmosphere);
        AtmosphereActor->SetRootComponent(Atmosphere);
        Atmosphere->SetMobility(EComponentMobility::Movable);
        Atmosphere->RegisterComponent();
    }
    // Свет создаётся один раз, а не при каждом выборе маршрута.
    if (auto* Sun = GetWorld()->SpawnActor<ADirectionalLight>(FVector(0, 0, 1500), FRotator(-40, -30, 0))) {
        Sun->GetLightComponent()->SetMobility(EComponentMobility::Movable);
        Sun->GetLightComponent()->SetIntensity(4.f);
        Sun->GetLightComponent()->SetLightColor(FLinearColor(1.f,0.94f,0.84f));
        Sun->GetLightComponent()->SetCastShadows(true);
        if (auto* Light = Cast<UDirectionalLightComponent>(Sun->GetLightComponent())) Light->bAtmosphereSunLight = true;
    }
    if (auto* Sky = GetWorld()->SpawnActor<ASkyLight>()) {
        Sky->GetLightComponent()->SetMobility(EComponentMobility::Movable);
        Sky->GetLightComponent()->SetIntensity(0.7f);
        Sky->GetLightComponent()->SetLightColor(FLinearColor(0.7f,0.82f,1.f));
        // Равномерная заливка не зависит от наличия skybox в Entry-карте.
        Sky->GetLightComponent()->SetLowerHemisphereColor(FLinearColor(0.3f,0.35f,0.42f));
        Sky->GetLightComponent()->RecaptureSky();
    }
    BuildRoute(0);
}
void AUEDevGameMode::BuildRoute(int Id) {
    UWorld* World = GetWorld();
    for (const auto& Actor : RouteActors) if (IsValid(Actor.Get())) Actor->Destroy();
    RouteActors.Empty();
    FlushPersistentDebugLines(World);
    const auto Route = uedev::Route(Id);
    UStaticMesh* Cube = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
    UMaterialInterface* Surface = LoadObject<UMaterialInterface>(nullptr,TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
    auto Box = [&](FVector Position, FVector Scale, FLinearColor Color = FLinearColor(0.55f,0.58f,0.62f), bool Collision = true) {
        auto* Actor = World->SpawnActor<AStaticMeshActor>(Position, FRotator::ZeroRotator);
        if (!Actor) return;
        RouteActors.Add(Actor);
        Actor->GetStaticMeshComponent()->SetMobility(EComponentMobility::Movable);
        Actor->GetStaticMeshComponent()->SetStaticMesh(Cube);
        if (Surface) Actor->GetStaticMeshComponent()->SetMaterial(0,Surface);
        Actor->SetActorScale3D(Scale);
        Actor->GetStaticMeshComponent()->SetCollisionProfileName(Collision ? TEXT("BlockAll") : TEXT("NoCollision"));
        if (auto* Material = Actor->GetStaticMeshComponent()->CreateAndSetMaterialInstanceDynamic(0))
            Material->SetVectorParameterValue(TEXT("Color"), Color);
    };
    const double Forward=Route.HalfForward, Side=Route.HalfSide;
    Box(FVector(0,0,-25),FVector(Forward*2,Side*2,0.5),FLinearColor(0.09f,0.11f,0.13f));
    // Разметка только визуальная и не влияет на маршрут или sweep.
    const FLinearColor White(0.85f,0.85f,0.78f);
    for (double X=-Forward*100+500; X<Forward*100; X+=1000)
        Box(FVector(X,0,1),FVector(4,0.12,0.015),White,false);
    for (const double Y : {-Side*100+150, Side*100-150})
        Box(FVector(0,Y,1),FVector(Forward*2-3,0.15,0.015),White,false);
    Box(FVector(Forward*100,0,100),FVector(0.3,Side*2,2));
    Box(FVector(-Forward*100,0,100),FVector(0.3,Side*2,2));
    Box(FVector(0,Side*100,100),FVector(Forward*2,0.3,2));
    Box(FVector(0,-Side*100,100),FVector(Forward*2,0.3,2));
    if (Id==0) {
        UStaticMesh* Cone = LoadObject<UStaticMesh>(nullptr,TEXT("/Engine/BasicShapes/Cone.Cone"));
        for (int Index=0;Index<5;++Index) {
            const FVector Position(1500+Index*700,1200,0);
            Box(Position+FVector(0,0,5),FVector(0.6,0.6,0.1),FLinearColor(0.035f,0.035f,0.035f));
            auto* Marker = World->SpawnActor<AStaticMeshActor>(Position+FVector(0,0,45),FRotator::ZeroRotator);
            if (!Marker) continue;
            RouteActors.Add(Marker);
            auto* Mesh = Marker->GetStaticMeshComponent();
            Mesh->SetMobility(EComponentMobility::Movable);
            Mesh->SetStaticMesh(Cone);
            if (Surface) Mesh->SetMaterial(0,Surface);
            Marker->SetActorScale3D(FVector(0.45,0.45,0.8));
            Mesh->SetCollisionProfileName(TEXT("NoCollision"));
            if (auto* Material = Mesh->CreateAndSetMaterialInstanceDynamic(0))
                Material->SetVectorParameterValue(TEXT("Color"),FLinearColor(1.f,0.18f,0.015f));
        }
    }
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
    DrawText(TEXT("Esc — пауза | S+Enter — подготовка без сброса | L — фары | Backspace — холодный сброс"), FLinearColor::White, 24, 102);
    const auto& Run=Pawn->GetRouteRun();
    const auto& Route=Pawn->GetRoute();
    DrawText(FString::Printf(TEXT("КТ %d/%d | %.1f с | %.0f м | %s"),Run.Next,Route.Count,Run.Seconds,Run.Distance,
        Run.Done(Route) ? TEXT("Маршрут пройден. Esc → завершить") :
        Route.Points[Run.Next].Stop ? TEXT("Остановитесь в жёлтом круге") : TEXT("Пройдите следующую зелёную КТ")),FLinearColor::Yellow,24,128);
    DrawText(TEXT("Учебная симуляция. Не официальный экзамен. © OpenStreetMap contributors (веб-версия)."), FLinearColor::White, 24, 154);
}
