#include "UEDevPawn.h"
#include "UEDevPlayerController.h"
#include "Camera/CameraComponent.h"
#include "Components/BoxComponent.h"
#include "Components/InputComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Components/SpotLightComponent.h"
#include "Materials/MaterialInterface.h"
#include "GameFramework/PlayerController.h"
#include "GameFramework/HUD.h"
#include "GameFramework/SpringArmComponent.h"
#include "InputCoreTypes.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "UObject/ConstructorHelpers.h"
AUEDevPawn::AUEDevPawn() {
    PrimaryActorTick.bCanEverTick = true;
    Body = CreateDefaultSubobject<UBoxComponent>(TEXT("Body"));
    SetRootComponent(Body);
    Body->SetBoxExtent(FVector(215.5, 90, 70));
    Body->SetCollisionProfileName(TEXT("Pawn"));
    // Только визуальные детали: единый Body остаётся единственной коллизией.
    static ConstructorHelpers::FObjectFinder<UStaticMesh> Cube(TEXT("/Engine/BasicShapes/Cube.Cube"));
    static ConstructorHelpers::FObjectFinder<UStaticMesh> Cylinder(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
    static ConstructorHelpers::FObjectFinder<UMaterialInterface> Surface(TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
    auto Part = [&](const TCHAR* Name, UStaticMesh* Shape, FVector Position, FVector Scale, FRotator Rotation = FRotator::ZeroRotator) {
        auto* Detail = CreateDefaultSubobject<UStaticMeshComponent>(Name);
        Detail->SetupAttachment(Body);
        Detail->SetStaticMesh(Shape);
        if (Surface.Succeeded()) Detail->SetMaterial(0, Surface.Object);
        Detail->SetRelativeLocation(Position);
        Detail->SetRelativeScale3D(Scale);
        Detail->SetRelativeRotation(Rotation);
        Detail->SetCollisionEnabled(ECollisionEnabled::NoCollision);
        Detail->SetGenerateOverlapEvents(false);
        return Detail;
    };
    Part(TEXT("PaintBody"), Cube.Object, FVector(0,0,-10), FVector(4.2,1.74,0.58));
    Part(TEXT("PaintCabin"), Cube.Object, FVector(-25,0,35), FVector(2.05,1.5,0.65));
    Part(TEXT("GlassFront"), Cube.Object, FVector(79,0,38), FVector(0.025,1.38,0.48));
    Part(TEXT("GlassRear"), Cube.Object, FVector(-129,0,38), FVector(0.025,1.38,0.48));
    Part(TEXT("GlassLeft"), Cube.Object, FVector(-25,-76,38), FVector(1.83,0.025,0.48));
    Part(TEXT("GlassRight"), Cube.Object, FVector(-25,76,38), FVector(1.83,0.025,0.48));
    Part(TEXT("TrimFront"), Cube.Object, FVector(211,0,-22), FVector(0.08,1.65,0.18));
    Part(TEXT("TrimRear"), Cube.Object, FVector(-211,0,-22), FVector(0.08,1.65,0.18));
    Part(TEXT("LampFront"), Cube.Object, FVector(216,0,0), FVector(0.025,1.4,0.13));
    Part(TEXT("LampRear"), Cube.Object, FVector(-216,0,0), FVector(0.025,1.4,0.13));
    Part(TEXT("TireFL"), Cylinder.Object, FVector(130,-82,-37), FVector(0.66,0.66,0.22), FRotator(0,0,90));
    Part(TEXT("TireFR"), Cylinder.Object, FVector(130,82,-37), FVector(0.66,0.66,0.22), FRotator(0,0,90));
    Part(TEXT("TireRL"), Cylinder.Object, FVector(-135,-82,-37), FVector(0.66,0.66,0.22), FRotator(0,0,90));
    Part(TEXT("TireRR"), Cylinder.Object, FVector(-135,82,-37), FVector(0.66,0.66,0.22), FRotator(0,0,90));
    auto Beam = [&](const TCHAR* Name, FVector Position, FRotator Rotation, FLinearColor Color, float Intensity, float Radius) {
        auto* Light = CreateDefaultSubobject<USpotLightComponent>(Name);
        Light->SetupAttachment(Body);
        Light->SetRelativeLocation(Position);
        Light->SetRelativeRotation(Rotation);
        Light->SetMobility(EComponentMobility::Movable);
        Light->SetLightColor(Color);
        Light->SetIntensity(Intensity);
        Light->SetAttenuationRadius(Radius);
        Light->SetInnerConeAngle(18.f);
        Light->SetOuterConeAngle(40.f);
        Light->SetCastShadows(false);
        Light->SetVisibility(false);
        return Light;
    };
    HeadLights.Add(Beam(TEXT("HeadLightL"),FVector(220,-60,-5),FRotator(-8,0,0),FLinearColor(1.f,0.94f,0.8f),18000.f,3500.f));
    HeadLights.Add(Beam(TEXT("HeadLightR"),FVector(220,60,-5),FRotator(-8,0,0),FLinearColor(1.f,0.94f,0.8f),18000.f,3500.f));
    StopLights.Add(Beam(TEXT("StopLightL"),FVector(-220,-60,-5),FRotator(-15,180,0),FLinearColor::Red,1500.f,350.f));
    StopLights.Add(Beam(TEXT("StopLightR"),FVector(-220,60,-5),FRotator(-15,180,0),FLinearColor::Red,1500.f,350.f));
    ReverseLight = Beam(TEXT("ReverseLight"),FVector(-220,0,-10),FRotator(-12,180,0),FLinearColor::White,3500.f,800.f);
    Arm = CreateDefaultSubobject<USpringArmComponent>(TEXT("CameraArm"));
    Arm->SetupAttachment(Body);
    Arm->TargetArmLength = 650;
    Arm->SetRelativeLocation(FVector(0, 0, 100));
    Arm->SetRelativeRotation(FRotator(-18, 0, 0));
    Arm->bDoCollisionTest = false;
    Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
    Camera->SetupAttachment(Arm);
    AutoPossessPlayer = EAutoReceiveInput::Player0;
}
void AUEDevPawn::BeginPlay() {
    Super::BeginPlay();
    TInlineComponentArray<UStaticMeshComponent*> Details(this);
    for (auto* Detail : Details) {
        auto* Material = Detail->CreateAndSetMaterialInstanceDynamic(0);
        if (!Material) continue;
        const FString Name = Detail->GetName();
        FLinearColor Color(0.04f,0.22f,0.48f);
        if (Name.StartsWith(TEXT("Glass"))) Color = FLinearColor(0.025f,0.055f,0.08f);
        else if (Name.StartsWith(TEXT("Tire")) || Name.StartsWith(TEXT("Trim"))) Color = FLinearColor(0.025f,0.025f,0.03f);
        else if (Name == TEXT("LampFront")) Color = FLinearColor(0.95f,0.9f,0.65f);
        else if (Name == TEXT("LampRear")) Color = FLinearColor(0.65f,0.015f,0.01f);
        Material->SetVectorParameterValue(TEXT("Color"), Color);
        if (Name == TEXT("LampRear")) RearLampMaterial = Material;
    }
    Reset();
}
bool AUEDevPawn::Down(const FKey& Key) const {
    const auto* PC = Cast<APlayerController>(GetController());
    return PC && PC->IsInputKeyDown(Key);
}
void AUEDevPawn::UpdateLights() {
    const auto Light = uedev::Lights(Model, HeadlightsOn);
    for (const auto& Beam : HeadLights) if (Beam) Beam->SetVisibility(Light.Head);
    for (const auto& Beam : StopLights) if (Beam) Beam->SetVisibility(Light.Stop);
    if (ReverseLight) ReverseLight->SetVisibility(Light.Reverse);
    if (RearLampMaterial) RearLampMaterial->SetVectorParameterValue(TEXT("Color"),
        Light.Stop ? FLinearColor(1.f,0.025f,0.01f) : FLinearColor(0.25f,0.008f,0.005f));
}
void AUEDevPawn::ToggleHud() {
    if (auto* PC = Cast<APlayerController>(GetController()))
        if (auto* Hud = PC->GetHUD()) Hud->ShowHUD();
}
void AUEDevPawn::ToggleHeadlights() { HeadlightsOn = !HeadlightsOn; UpdateLights(); }
void AUEDevPawn::ResetRide() { Reset(); }
void AUEDevPawn::Reset() {
    HeadlightsOn = false;
    Model = uedev::State{}; Accumulator = 0; Run = uedev::RouteRun{};
    Model.Z = ActiveRoute.StartZ;
    UpdateLights();
    SetActorLocationAndRotation(FVector(Model.Z * 100, 0, 71), FRotator::ZeroRotator, false);
}
void AUEDevPawn::Ready() { uedev::PrepareDrive(Model, Down(EKeys::S)); UpdateLights(); }
void AUEDevPawn::StartEngine() { uedev::ToggleEngine(Model); UpdateLights(); }
void AUEDevPawn::Handbrake() { Model.Handbrake = !Model.Handbrake; }
void AUEDevPawn::Belt() { Model.Belt = !Model.Belt; }
void AUEDevPawn::Choose(uedev::Gear Gear) { uedev::Select(Model, Gear, Down(EKeys::S)); UpdateLights(); }
void AUEDevPawn::Park() { Choose(uedev::Gear::P); }
void AUEDevPawn::Reverse() { Choose(uedev::Gear::R); }
void AUEDevPawn::Neutral() { Choose(uedev::Gear::N); }
void AUEDevPawn::Drive() { Choose(uedev::Gear::D); }
void AUEDevPawn::GearUp() {
    if (Down(EKeys::LeftShift) || Down(EKeys::RightShift)) {
        if (Model.Selector == uedev::Gear::D) Choose(static_cast<uedev::Gear>(static_cast<int>(uedev::Gear::M1) + Model.AutoGear - 1));
        else if (uedev::Manual(Model.Selector) && Model.Selector != uedev::Gear::M6)
            Choose(static_cast<uedev::Gear>(static_cast<int>(Model.Selector) + 1));
    } else if (Model.Selector < uedev::Gear::D) Choose(static_cast<uedev::Gear>(static_cast<int>(Model.Selector) + 1));
}
void AUEDevPawn::GearDown() {
    if (Down(EKeys::LeftShift) || Down(EKeys::RightShift)) {
        if (uedev::Manual(Model.Selector) && Model.Selector != uedev::Gear::M1)
            Choose(static_cast<uedev::Gear>(static_cast<int>(Model.Selector) - 1));
    } else if (Model.Selector > uedev::Gear::P && Model.Selector <= uedev::Gear::D)
        Choose(static_cast<uedev::Gear>(static_cast<int>(Model.Selector) - 1));
}
void AUEDevPawn::MouseX(float Value) {
    if (Down(EKeys::RightMouseButton)) Arm->AddRelativeRotation(FRotator(0, Value * 0.25f, 0));
    else if (Down(EKeys::LeftMouseButton)) Model.WheelDeg = FMath::Clamp(Model.WheelDeg - Value * 2.1, -540.0, 540.0);
}
void AUEDevPawn::MouseY(float Value) {
    if (!Down(EKeys::RightMouseButton)) return;
    FRotator R = Arm->GetRelativeRotation();
    R.Pitch = FMath::Clamp(R.Pitch + Value * 0.25f, -75.f, 10.f);
    Arm->SetRelativeRotation(R);
}
void AUEDevPawn::Zoom(float Value) {
    if (Down(EKeys::LeftControl) || Down(EKeys::RightControl)) {
        SetOrdinaryGas(OrdinaryGas + Value * 0.05);
        if (auto* PC = Cast<AUEDevPlayerController>(GetController())) PC->SavePreferences();
    } else Arm->TargetArmLength = FMath::Clamp(Arm->TargetArmLength - Value * 50.f, 250.f, 1400.f);
}
void AUEDevPawn::SetupPlayerInputComponent(UInputComponent* Input) {
    Super::SetupPlayerInputComponent(Input);
    Input->BindKey(EKeys::H, IE_Pressed, this, &AUEDevPawn::ToggleHud);
    Input->BindKey(EKeys::L, IE_Pressed, this, &AUEDevPawn::ToggleHeadlights);
    Input->BindKey(EKeys::I, IE_Pressed, this, &AUEDevPawn::StartEngine);
    Input->BindKey(EKeys::Enter, IE_Pressed, this, &AUEDevPawn::Ready);
    Input->BindKey(EKeys::BackSpace, IE_Pressed, this, &AUEDevPawn::Reset);
    Input->BindKey(EKeys::SpaceBar, IE_Pressed, this, &AUEDevPawn::Handbrake);
    Input->BindKey(EKeys::B, IE_Pressed, this, &AUEDevPawn::Belt);
    Input->BindKey(EKeys::P, IE_Pressed, this, &AUEDevPawn::Park);
    Input->BindKey(EKeys::R, IE_Pressed, this, &AUEDevPawn::Reverse);
    Input->BindKey(EKeys::N, IE_Pressed, this, &AUEDevPawn::Neutral);
    Input->BindKey(EKeys::F, IE_Pressed, this, &AUEDevPawn::Drive);
    Input->BindKey(EKeys::Up, IE_Pressed, this, &AUEDevPawn::GearUp);
    Input->BindKey(EKeys::Down, IE_Pressed, this, &AUEDevPawn::GearDown);
    Input->BindAxisKey(EKeys::MouseX, this, &AUEDevPawn::MouseX);
    Input->BindAxisKey(EKeys::MouseY, this, &AUEDevPawn::MouseY);
    Input->BindAxisKey(EKeys::MouseWheelAxis, this, &AUEDevPawn::Zoom);
    if (auto* PC = Cast<AUEDevPlayerController>(GetController())) {
        if (!PC->IsDriving()) DisableInput(PC);
    }
}
void AUEDevPawn::Tick(float DeltaSeconds) {
    Super::Tick(DeltaSeconds);
    const uedev::Input Input{Down(EKeys::W), Down(EKeys::S), Down(EKeys::LeftShift) || Down(EKeys::RightShift),
        (Down(EKeys::A) ? 1.0 : 0.0) - (Down(EKeys::D) ? 1.0 : 0.0)};
    // Максимум 15 шагов за кадр: при длинной паузе замедляем время, а не прыгаем сквозь мир.
    Accumulator += FMath::Clamp(static_cast<double>(DeltaSeconds), 0.0, 0.25);
    while (Accumulator >= uedev::Dt) {
        auto StepInput = Input;
        StepInput.GasLimit = OrdinaryGas;
        if (Down(EKeys::LeftMouseButton)) { StepInput.Steer = 0; StepInput.HoldSteer = true; }
        const double PreviousX = Model.X, PreviousZ = Model.Z;
        uedev::Step(Model, StepInput);
        FHitResult Hit;
        SetActorLocationAndRotation(FVector(Model.Z * 100, -Model.X * 100, 71),
            FRotator(0, -Model.Heading * 180 / uedev::Pi, 0), true, &Hit);
        if (Hit.bBlockingHit) {
            const FVector Position = GetActorLocation();
            Model.Z = Position.X / 100; Model.X = -Position.Y / 100; Model.Speed = 0;
        }
        Run.Advance(ActiveRoute, PreviousX, PreviousZ, Model.X, Model.Z, Model.Speed, uedev::Dt);
        Accumulator -= uedev::Dt;
    }
    UpdateLights();
}
