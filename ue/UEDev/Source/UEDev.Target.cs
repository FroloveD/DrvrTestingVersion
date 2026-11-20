using UnrealBuildTool;
using System.Collections.Generic;
public class UEDevTarget : TargetRules
{
    public UEDevTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Game;
        DefaultBuildSettings = BuildSettingsVersion.V5;
        ExtraModuleNames.Add("UEDev");
    }
}
