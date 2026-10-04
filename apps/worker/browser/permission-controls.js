/** Permission dependencies and presets come from the server's shared policy. */
export function bindPermissionControls(root, claim) {
  root.querySelectorAll("form").forEach(form => {
    const controls = Array.from(form.querySelectorAll("select[data-permission-requires]"));
    if (!controls.length || !claim(form, "permission-controls")) return;
    const requirements = control => (control.getAttribute("data-permission-requires") || "").split(" ").filter(Boolean);
    const profile = form.querySelector('select[name="profile"]');
    controls.forEach(changed => {
      changed.addEventListener("change", () => {
        if (changed.value === "true") {
          for (const name of requirements(changed)) {
            const required = controls.find(control => control.name === name);
            if (required) required.value = "true";
          }
        } else {
          controls.forEach(control => {
            if (requirements(control).includes(changed.name)) control.value = "false";
          });
        }
        // An explicit field edit must not be overwritten by the prior preset.
        if (profile) profile.value = "custom";
      });
    });
    if (profile) profile.addEventListener("change", () => {
      const preset = profile.selectedOptions[0]?.getAttribute("data-permission-preset");
      if (preset === null || preset === undefined) return;
      const enabled = new Set(preset.split(" ").filter(Boolean));
      controls.forEach(control => { control.value = String(enabled.has(control.name)); });
    });
  });
}
