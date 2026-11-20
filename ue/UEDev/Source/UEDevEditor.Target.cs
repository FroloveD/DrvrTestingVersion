using UnrealBuildTool;
using System.Collections.Generic;
public class UEDevEditorTarget : TargetRules
{
    public UEDevEditorTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Editor;
        DefaultBuildSettings = BuildSettingsVersion.V5;
        ExtraModuleNames.Add("UEDev");
    }
}
