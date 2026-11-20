/**
 * @module UEDev/Pawn
 * @layer ue-adapter
 * @role Клавиатура/мышь, аккумулятор 60 Гц, сборная low-poly машина, камера и sweep-столкновения.
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
class USceneCaptureComponent2D;
class UTextureRenderTarget2D;
class UTextRenderComponent;
class UBoxComponent;
class USceneComponent;
class USpringArmComponent;
class UCameraComponent;
class USpotLightComponent;
class UStaticMeshComponent;
class UMaterialInstanceDynamic;
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
    bool AreHeadlightsOn() const { return HeadlightsOn; }
    UTextureRenderTarget2D* GetMirror(int Index) const { return MirrorTargets.IsValidIndex(Index) ? MirrorTargets[Index].Get() : nullptr; }
    bool IsMirrorEnabled(int Index) const { return Index>=0 && Index<3 && MirrorEnabled[Index]; }
    bool IsCabinView() const { return CabinView; }
    const uedev::State& GetDrivingState() const { return Model; }
private:
    UPROPERTY() TObjectPtr<UBoxComponent> Body;
    UPROPERTY() TObjectPtr<USpringArmComponent> Arm;
    UPROPERTY() TObjectPtr<UCameraComponent> Camera;
    UPROPERTY() TObjectPtr<UCameraComponent> CabinCamera;
    UPROPERTY() TObjectPtr<USceneComponent> SteeringPivot;
    UPROPERTY() TArray<TObjectPtr<UStaticMeshComponent>> CabinParts;
    UPROPERTY() TArray<TObjectPtr<UStaticMeshComponent>> CabinOccluders;
    UPROPERTY() TArray<TObjectPtr<USceneCaptureComponent2D>> MirrorCaptures;
    UPROPERTY() TArray<TObjectPtr<UTextureRenderTarget2D>> MirrorTargets;
    UPROPERTY() TObjectPtr<UTextRenderComponent> DashboardDisplay;
    float MirrorElapsed = 0;
    bool MirrorEnabled[3] = {true,true,true};
    void ToggleRearMirror();
    void ToggleLeftMirror();
    void ToggleRightMirror();
    void UpdateCabin(float DeltaSeconds);
    bool CabinView = false;
    void ToggleCamera();
    void ExteriorView();
    void InteriorView();
    void ApplyCameraView();
    UPROPERTY() TArray<TObjectPtr<USpotLightComponent>> HeadLights;
    UPROPERTY() TArray<TObjectPtr<USpotLightComponent>> StopLights;
    UPROPERTY() TObjectPtr<USpotLightComponent> ReverseLight;
    UPROPERTY() TObjectPtr<UMaterialInstanceDynamic> RearLampMaterial;
    void UpdateLights();
    void ToggleHeadlights();
    void ToggleHud();
    bool HeadlightsOn = false;
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
