#include "UEDevPawn.h"
#include "UEDevPlayerController.h"
#include "Camera/CameraComponent.h"
#include "Components/BoxComponent.h"
#include "Components/InputComponent.h"
#include "Components/StaticMeshComponent.h"
#include "GameFramework/PlayerController.h"
#include "GameFramework/SpringArmComponent.h"
#include "InputCoreTypes.h"
#include "UObject/ConstructorHelpers.h"
AUEDevPawn::AUEDevPawn() {
    PrimaryActorTick.bCanEverTick = true;
    Body = CreateDefaultSubobject<UBoxComponent>(TEXT("Body"));
    SetRootComponent(Body);
    Body->SetBoxExtent(FVector(215.5, 90, 70));
    Body->SetCollisionProfileName(TEXT("Pawn"));
    auto* Mesh = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Placeholder"));
    Mesh->SetupAttachment(Body);
    static ConstructorHelpers::FObjectFinder<UStaticMesh> Cube(TEXT("/Engine/BasicShapes/Cube.Cube"));
    Mesh->SetStaticMesh(Cube.Object);
    Mesh->SetRelativeScale3D(FVector(4.31, 1.8, 1.4));
    Mesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
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
void AUEDevPawn::BeginPlay() { Super::BeginPlay(); Reset(); }
bool AUEDevPawn::Down(const FKey& Key) const {
    const auto* PC = Cast<APlayerController>(GetController());
    return PC && PC->IsInputKeyDown(Key);
}
void AUEDevPawn::ResetRide() { Reset(); }
void AUEDevPawn::Reset() {
    Model = uedev::State{}; Accumulator = 0;
    SetActorLocationAndRotation(FVector(0, 0, 71), FRotator::ZeroRotator, false);
}
void AUEDevPawn::Ready() { Reset(); Model.Engine = true; Model.Handbrake = false; Model.Belt = true; Model.Selector = uedev::Gear::D; }
void AUEDevPawn::StartEngine() { uedev::ToggleEngine(Model); }
void AUEDevPawn::Handbrake() { Model.Handbrake = !Model.Handbrake; }
void AUEDevPawn::Belt() { Model.Belt = !Model.Belt; }
void AUEDevPawn::Choose(uedev::Gear Gear) { uedev::Select(Model, Gear, Down(EKeys::S)); }
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
        OrdinaryGas = FMath::Clamp(OrdinaryGas + Value * 0.05, 0.1, 0.6);
    } else Arm->TargetArmLength = FMath::Clamp(Arm->TargetArmLength - Value * 50.f, 250.f, 1400.f);
}
void AUEDevPawn::SetupPlayerInputComponent(UInputComponent* Input) {
    Super::SetupPlayerInputComponent(Input);
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
        uedev::Step(Model, StepInput);
        FHitResult Hit;
        SetActorLocationAndRotation(FVector(Model.Z * 100, -Model.X * 100, 71),
            FRotator(0, -Model.Heading * 180 / uedev::Pi, 0), true, &Hit);
        if (Hit.bBlockingHit) {
            const FVector Position = GetActorLocation();
            Model.Z = Position.X / 100; Model.X = -Position.Y / 100; Model.Speed = 0;
        }
        Accumulator -= uedev::Dt;
    }
}
