/**
 * @module UEDev/Pawn
 * @layer ue-adapter
 * @role Клавиатура/мышь, аккумулятор 60 Гц, куб-машина, камера и sweep-столкновения.
 * @invariants Ядро SI → UE сантиметры: (z*100, -x*100, высота), yaw=-heading.
 * @tests Ручной smoke в ue/README.md; UE-компиляция требует установленного SDK.
 */
#pragma once
#include "CoreMinimal.h"
#include "GameFramework/Pawn.h"
#include "InputCoreTypes.h"
#include "DrivingModel.h"
#include "RouteRun.h"
#include "UEDevPawn.generated.h"
class UBoxComponent;
class USpringArmComponent;
class UCameraComponent;
UCLASS()
class UEDEV_API AUEDevPawn : public APawn {
    GENERATED_BODY()
public:
    AUEDevPawn();
    virtual void BeginPlay() override;
    virtual void Tick(float DeltaSeconds) override;
    virtual void SetupPlayerInputComponent(UInputComponent* Input) override;
    void ResetRide();
    void SetRoute(int Id) { ActiveRoute = uedev::Route(Id); Reset(); }
    const uedev::TestRoute& GetRoute() const { return ActiveRoute; }
    const uedev::RouteRun& GetRouteRun() const { return Run; }
    void SetOrdinaryGas(double Value) { OrdinaryGas = uedev::OrdinaryGasLimit(Value); }
    double GetOrdinaryGas() const { return OrdinaryGas; }
    const uedev::State& GetDrivingState() const { return Model; }
private:
    UPROPERTY() TObjectPtr<UBoxComponent> Body;
    UPROPERTY() TObjectPtr<USpringArmComponent> Arm;
    UPROPERTY() TObjectPtr<UCameraComponent> Camera;
    uedev::State Model;
    uedev::TestRoute ActiveRoute = uedev::Route(0);
    uedev::RouteRun Run;
    double Accumulator = 0;
    double OrdinaryGas = 0.6;
    void Reset();
    void StartEngine();
    void Ready();
    void Handbrake();
    void Belt();
    void Park();
    void Reverse();
    void Neutral();
    void Drive();
    void GearUp();
    void GearDown();
    void MouseX(float Value);
    void MouseY(float Value);
    void Zoom(float Value);
    void Choose(uedev::Gear Gear);
    bool Down(const FKey& Key) const;
};
