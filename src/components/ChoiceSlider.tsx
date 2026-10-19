import { SliderField } from "@decky/ui";
import { useEffect, useMemo, useState } from "react";

export type Choice<T> = { value: T; short: string; label?: string };

// A notched slider for picking one of a few options. Used instead of
// dropdowns: a dropdown opens a separate menu, and backing out of it with B
// also backed out of Discordio, so you had to navigate all the way back in.
// The slider changes in place with left / right.
export function ChoiceSlider<T>({
  label,
  description,
  choices,
  value,
  onChange,
}: {
  label: string;
  description?: string;
  choices: Choice<T>[];
  value: T;
  onChange: (v: T) => void;
}) {
  const fromProps = Math.max(0, choices.findIndex((c) => c.value === value));
  // Moves at once on left / right; saving happens in the background. (It used
  // to wait for the save, and panel refreshes, frequent while live, snapped
  // it back before the save landed, so it seemed stuck.)
  const [index, setIndex] = useState(fromProps);
  useEffect(() => setIndex(fromProps), [fromProps]);
  const notches = useMemo(
    () => choices.map((c, i) => ({ notchIndex: i, label: c.short, value: i })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [choices.map((c) => c.short).join("|")]
  );
  const current = choices[index];
  return (
    <SliderField
      label={`${label}: ${current?.label ?? current?.short ?? ""}`}
      description={description}
      value={index}
      min={0}
      max={choices.length - 1}
      step={1}
      notchCount={choices.length}
      notchLabels={notches}
      notchTicksVisible
      validValues="steps"
      showValue={false}
      onChange={(i) => {
        const n = Math.max(0, Math.min(choices.length - 1, Math.round(i)));
        setIndex(n);
        const c = choices[n];
        if (c && c.value !== value) onChange(c.value);
      }}
    />
  );
}
