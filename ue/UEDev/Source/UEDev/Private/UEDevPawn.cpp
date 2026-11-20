#include "UEDevPawn.h"
#include "UEDevPlayerController.h"
#include "UEDevGameMode.h"
#include "HudModel.h"
#include "Camera/CameraComponent.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Components/TextRenderComponent.h"
#include "Engine/TextureRenderTarget2D.h"
#include "Components/BoxComponent.h"
#include "Components/SceneComponent.h"
#include "Components/WidgetComponent.h"
#include "Widgets/Images/SImage.h"
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
        const FString PartName(Name);
        if (PartName.StartsWith(TEXT("Interior"))) CabinParts.Add(Detail);
        if (PartName==TEXT("PaintCabin") || PartName.StartsWith(TEXT("Glass"))) CabinOccluders.Add(Detail);
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
    // Простой салон: прозрачность стекла не требуется — проёмы открыты.
    Part(TEXT("InteriorDash"),Cube.Object,FVector(73,0,12),FVector(0.55,1.42,0.22));
    Part(TEXT("InteriorConsole"),Cube.Object,FVector(-10,0,-3),FVector(1.35,0.27,0.3));
    Part(TEXT("InteriorDoorL"),Cube.Object,FVector(-24,-78,4),FVector(2.05,0.06,0.38));
    Part(TEXT("InteriorDoorR"),Cube.Object,FVector(-24,78,4),FVector(2.05,0.06,0.38));
    Part(TEXT("InteriorRoof"),Cube.Object,FVector(-25,0,73),FVector(2.12,1.56,0.05));
    Part(TEXT("InteriorPillarL"),Cube.Object,FVector(78,-74,43),FVector(0.07,0.07,0.6));
    Part(TEXT("InteriorPillarR"),Cube.Object,FVector(78,74,43),FVector(0.07,0.07,0.6));
    Part(TEXT("InteriorRearPillarL"),Cube.Object,FVector(-129,-74,43),FVector(0.1,0.07,0.6));
    Part(TEXT("InteriorRearPillarR"),Cube.Object,FVector(-129,74,43),FVector(0.1,0.07,0.6));
    SteeringPivot = CreateDefaultSubobject<USceneComponent>(TEXT("SteeringPivot"));
    SteeringPivot->SetupAttachment(Body);
    SteeringPivot->SetRelativeLocation(FVector(38,-38,28));
    for (int Index=0;Index<16;++Index) {
        const double Angle=Index*2*uedev::Pi/16;
        auto* Rim = Part(*FString::Printf(TEXT("InteriorRim%d"),Index),Cube.Object,FVector::ZeroVector,FVector(0.035,0.075,0.035));
        Rim->SetupAttachment(SteeringPivot);
        Rim->SetRelativeLocation(FVector(0,18*std::cos(Angle),18*std::sin(Angle)));
        Rim->SetRelativeRotation(FRotator(0,0,Index*360.f/16+90));
    }
    auto* Hub = Part(TEXT("InteriorWheelHub"),Cube.Object,FVector::ZeroVector,FVector(0.06,0.12,0.1));
    Hub->SetupAttachment(SteeringPivot);
    auto* Spoke = Part(TEXT("InteriorWheelSpoke"),Cube.Object,FVector(0,0,-8),FVector(0.035,0.035,0.16));
    Spoke->SetupAttachment(SteeringPivot);
    auto* CrossSpoke = Part(TEXT("InteriorWheelCross"),Cube.Object,FVector::ZeroVector,FVector(0.035,0.33,0.035));
    CrossSpoke->SetupAttachment(SteeringPivot);
    Part(TEXT("InteriorCluster"),Cube.Object,FVector(48,-38,36),FVector(0.05,0.42,0.26));
    // Индикатор на торпедо виден с водительского места, независимо от HUD.
    DashboardDisplay = CreateDefaultSubobject<UTextRenderComponent>(TEXT("DashboardDisplay"));
    DashboardDisplay->SetupAttachment(Body);
    DashboardDisplay->SetRelativeLocation(FVector(44,-38,45));
    DashboardDisplay->SetRelativeRotation(FRotator(0,180,0));
    DashboardDisplay->SetWorldSize(3.5f);
    DashboardDisplay->SetHorizontalAlignment(EHTA_Center);
    DashboardDisplay->SetTextRenderColor(FColor(100,240,210));
    DashboardDisplay->SetCollisionEnabled(ECollisionEnabled::NoCollision);
    for (int Index=0;Index<3;++Index) {
        const FVector Position = Index==0 ? FVector(65,0,62) : FVector(65,Index==1 ? -97 : 97,35);
        const FRotator Facing = (FVector(-30,-38,58)-Position).Rotation();
        Part(*FString::Printf(TEXT("InteriorMirrorFrame%d"),Index),Cube.Object,Position,
            Index==0 ? FVector(0.05,0.27,0.095) : FVector(0.05,0.22,0.12),Facing);
        auto* SurfaceWidget = CreateDefaultSubobject<UWidgetComponent>(*FString::Printf(TEXT("PhysicalMirror%d"),Index));
        SurfaceWidget->SetupAttachment(Body);
        SurfaceWidget->SetRelativeLocation(Position+Facing.Vector()*3);
        SurfaceWidget->SetRelativeRotation(Facing);
        SurfaceWidget->SetRelativeScale3D(FVector(Index==0 ? 0.075 : 0.06));
        SurfaceWidget->SetWidgetSpace(EWidgetSpace::World);
        SurfaceWidget->SetDrawSize(FVector2D(320,Index==0 ? 96 : 160));
        SurfaceWidget->SetPivot(FVector2D(0.5,0.5));
        SurfaceWidget->SetCollisionEnabled(ECollisionEnabled::NoCollision);
        SurfaceWidget->SetCastShadow(false);
        SurfaceWidget->SetTwoSided(true);
        MirrorSurfaces.Add(SurfaceWidget);
        auto* Capture = CreateDefaultSubobject<USceneCaptureComponent2D>(*FString::Printf(TEXT("MirrorCapture%d"),Index));
        Capture->SetupAttachment(Body);
        Capture->SetRelativeLocation(Index==0 ? FVector(0,0,62) : FVector(75,Index==1 ? -100 : 100,38));
        Capture->SetRelativeRotation(FRotator(Index==0 ? -5 : -3,Index==0 ? 180 : Index==1 ? -170 : 170,0));
        Capture->FOVAngle = Index==0 ? 50.f : 65.f;
        Capture->CaptureSource = ESceneCaptureSource::SCS_FinalColorLDR;
        Capture->bCaptureEveryFrame = false;
        Capture->bCaptureOnMovement = false;
        MirrorCaptures.Add(Capture);
    }
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
    CabinCamera = CreateDefaultSubobject<UCameraComponent>(TEXT("CabinCamera"));
    CabinCamera->SetupAttachment(Body);
    CabinCamera->SetRelativeLocation(FVector(-30,-38,58));
    CabinCamera->SetRelativeRotation(FRotator(-5,0,0));
    CabinCamera->SetFieldOfView(85);
    CabinCamera->SetAutoActivate(false);
    CabinCamera->SetActive(false);
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
        if (Name.StartsWith(TEXT("Interior"))) Color = FLinearColor(0.035f,0.045f,0.055f);
        else if (Name.StartsWith(TEXT("Glass"))) Color = FLinearColor(0.025f,0.055f,0.08f);
        else if (Name.StartsWith(TEXT("Tire")) || Name.StartsWith(TEXT("Trim"))) Color = FLinearColor(0.025f,0.025f,0.03f);
        else if (Name == TEXT("LampFront")) Color = FLinearColor(0.95f,0.9f,0.65f);
        else if (Name == TEXT("LampRear")) Color = FLinearColor(0.65f,0.015f,0.01f);
        Material->SetVectorParameterValue(TEXT("Color"), Color);
        if (Name == TEXT("LampRear")) RearLampMaterial = Material;
    }
    MirrorBrushes.SetNum(3);
    for (int Index=0;Index<MirrorCaptures.Num();++Index) {
        auto* Target = NewObject<UTextureRenderTarget2D>(this);
        Target->RenderTargetFormat = RTF_RGBA8;
        Target->ClearColor = FLinearColor::Black;
        Target->InitAutoFormat(320,Index==0 ? 96 : 160);
        MirrorTargets.Add(Target);
        MirrorBrushes[Index].SetResourceObject(Target);
        MirrorBrushes[Index].ImageSize=FVector2D(320,Index==0 ? 96 : 160);
        MirrorBrushes[Index].SetUVRegion(FBox2f(FVector2f(1,0),FVector2f(0,1)));
        MirrorSurfaces[Index]->SetSlateWidget(SNew(SImage).Image(&MirrorBrushes[Index]));
        // Ни одна зеркальная поверхность не попадает в другой capture (нет рекурсии).
        for (const auto& SurfaceWidget : MirrorSurfaces) MirrorCaptures[Index]->HideComponent(SurfaceWidget.Get());
        MirrorCaptures[Index]->TextureTarget = Target;
        // В зеркале нет кабины/дисплея, но остаются кузов и колёса как ориентиры.
        for (const auto& Detail : CabinParts) MirrorCaptures[Index]->HideComponent(Detail.Get());
        for (const auto& Detail : CabinOccluders) MirrorCaptures[Index]->HideComponent(Detail.Get());
        MirrorCaptures[Index]->HideComponent(DashboardDisplay);
    }
    Reset();
    ApplyCameraView();
    UpdateCabin(1.f);
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
void AUEDevPawn::ToggleRearMirror() { MirrorEnabled[0]=!MirrorEnabled[0]; MirrorElapsed=1; }
void AUEDevPawn::ToggleLeftMirror() { MirrorEnabled[1]=!MirrorEnabled[1]; MirrorElapsed=1; }
void AUEDevPawn::ToggleRightMirror() { MirrorEnabled[2]=!MirrorEnabled[2]; MirrorElapsed=1; }
void AUEDevPawn::UpdateCabin(float DeltaSeconds) {
    // Стрелки поворачивают взгляд при удержании, отпускание возвращает к дороге.
    if (CabinView) {
        FRotator R = CabinCamera->GetRelativeRotation();
        R.Yaw = HeadControl.Step(R.Yaw,Down(EKeys::Left),Down(EKeys::Right),DeltaSeconds,HeadReturnSpeed);
        CabinCamera->SetRelativeRotation(R);
    }
    const FString GearLabel = Model.Selector==uedev::Gear::D ? FString::Printf(TEXT("D%d"),Model.AutoGear) : FString(UTF8_TO_TCHAR(uedev::Label(Model.Selector)));
    DashboardDisplay->SetText(FText::FromString(FString::Printf(TEXT("%.0f км/ч   %s\n%.0f об/мин\n%s  %s\n%s"),
        FMath::Abs(Model.Speed)*3.6,*GearLabel,Model.Rpm,Model.Engine ? TEXT("ДВС ВКЛ") : TEXT("ДВС ВЫКЛ"),
        Model.Handbrake ? TEXT("РУЧНИК") : TEXT(""),Model.Belt ? TEXT("РЕМЕНЬ ДА") : TEXT("РЕМЕНЬ НЕТ"))));
    for (int Index=0;Index<MirrorSurfaces.Num();++Index) MirrorSurfaces[Index]->SetVisibility(CabinView && MirrorEnabled[Index]);
    MirrorElapsed += DeltaSeconds;
    if (MirrorElapsed>=1.f/15.f) {
        MirrorElapsed=0;
        for (int Index=0;Index<MirrorCaptures.Num();++Index)
            if (MirrorEnabled[Index] && MirrorCaptures[Index]->TextureTarget) MirrorCaptures[Index]->CaptureScene();
    }
}
void AUEDevPawn::ApplyCameraView() {
    HeadControl = uedev::HeadLook{};
    Camera->SetActive(!CabinView);
    CabinCamera->SetActive(CabinView);
    DashboardDisplay->SetVisibility(CabinView);
    for (int Index=0;Index<MirrorSurfaces.Num();++Index) MirrorSurfaces[Index]->SetVisibility(CabinView && MirrorEnabled[Index]);
    for (const auto& Detail : CabinParts) if (Detail) Detail->SetVisibility(CabinView);
    for (const auto& Detail : CabinOccluders) if (Detail) Detail->SetVisibility(!CabinView);
}
void AUEDevPawn::ToggleCamera() { CabinView = !CabinView; ApplyCameraView(); }
void AUEDevPawn::ExteriorView() { CabinView = false; ApplyCameraView(); }
void AUEDevPawn::InteriorView() {
    CabinView = true;
    CabinCamera->SetRelativeRotation(FRotator(-5,0,0));
    CabinCamera->SetFieldOfView(85);
    ApplyCameraView();
}
void AUEDevPawn::ToggleHud() {
    if (auto* PC = Cast<APlayerController>(GetController()))
        if (auto* Hud = Cast<AUEDevHUD>(PC->GetHUD())) Hud->TogglePanels();
}
void AUEDevPawn::ToggleHeadlights() { HeadlightsOn = !HeadlightsOn; UpdateLights(); }
void AUEDevPawn::ResetRide() { Reset(); }
void AUEDevPawn::Reset() {
    HeadlightsOn = false;
    Model = uedev::State{}; Accumulator = 0; Run = uedev::RouteRun{};
    Model.Z = ActiveRoute.StartZ;
    SteeringPivot->SetRelativeRotation(FRotator::ZeroRotator);
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
    if (Down(EKeys::RightMouseButton)) {
        if (CabinView) {
            if (Value!=0) HeadControl = uedev::HeadLook{};
            FRotator R = CabinCamera->GetRelativeRotation();
            R.Yaw = FMath::Clamp(R.Yaw + Value*0.25f,-110.f,110.f);
            CabinCamera->SetRelativeRotation(R);
        } else Arm->AddRelativeRotation(FRotator(0, Value * 0.25f, 0));
    }
    else if (Down(EKeys::LeftMouseButton)) Model.WheelDeg = FMath::Clamp(Model.WheelDeg - Value * 2.1, -540.0, 540.0);
}
void AUEDevPawn::MouseY(float Value) {
    if (!Down(EKeys::RightMouseButton)) return;
    if (CabinView) {
        if (Value!=0) HeadControl = uedev::HeadLook{};
        FRotator R = CabinCamera->GetRelativeRotation();
        R.Pitch = FMath::Clamp(R.Pitch + Value*0.25f,-40.f,30.f);
        CabinCamera->SetRelativeRotation(R);
    } else {
        FRotator R = Arm->GetRelativeRotation();
        R.Pitch = FMath::Clamp(R.Pitch + Value * 0.25f, -75.f, 10.f);
        Arm->SetRelativeRotation(R);
    }
}
void AUEDevPawn::Zoom(float Value) {
    if (Down(EKeys::LeftControl) || Down(EKeys::RightControl)) {
        SetOrdinaryGas(OrdinaryGas + Value * 0.05);
        if (auto* PC = Cast<AUEDevPlayerController>(GetController())) PC->SavePreferences();
    } else if (CabinView) CabinCamera->SetFieldOfView(FMath::Clamp(CabinCamera->FieldOfView-Value*3.f,65.f,100.f));
    else Arm->TargetArmLength = FMath::Clamp(Arm->TargetArmLength - Value * 50.f, 250.f, 1400.f);
}
void AUEDevPawn::SetupPlayerInputComponent(UInputComponent* Input) {
    Super::SetupPlayerInputComponent(Input);
    Input->BindKey(EKeys::F5, IE_Pressed, this, &AUEDevPawn::ToggleRearMirror);
    Input->BindKey(EKeys::F6, IE_Pressed, this, &AUEDevPawn::ToggleLeftMirror);
    Input->BindKey(EKeys::F7, IE_Pressed, this, &AUEDevPawn::ToggleRightMirror);
    Input->BindKey(EKeys::C, IE_Pressed, this, &AUEDevPawn::ToggleCamera);
    Input->BindKey(EKeys::One, IE_Pressed, this, &AUEDevPawn::ExteriorView);
    Input->BindKey(EKeys::Two, IE_Pressed, this, &AUEDevPawn::InteriorView);
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
    SteeringPivot->SetRelativeRotation(FRotator(0,0,-Model.WheelDeg));
    UpdateLights();
    UpdateCabin(DeltaSeconds);
}
