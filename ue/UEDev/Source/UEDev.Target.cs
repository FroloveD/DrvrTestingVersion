using UnrealBuildTool;
using System.Collections.Generic;
public class UEDevTarget : TargetRules
{
    public UEDevTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Game;
        DefaultBuildSettings = BuildSettingsVersion.V6;
        ExtraModuleNames.Add("UEDev");
    }
}
