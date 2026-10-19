import { SliderField } from "@decky/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { logSlider } from "../lib/diag";

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
  const renders = useRef(0);
  renders.current++;
  useEffect(() => {
    if (fromProps !== index) logSlider(label, `saved value came back as #${fromProps} (${choices[fromProps]?.short}), showing #${index}`);
    setIndex(fromProps);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromProps]);
  // Mounting again (instead of updating) would reset Steam's slider mid-press.
  useEffect(() => {
    logSlider(label, `shown at #${fromProps} (${choices[fromProps]?.short})`);
    return () => logSlider(label, `removed after ${renders.current} redraws`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
        logSlider(label, `moved: Steam reported ${i}, now #${n} (${choices[n]?.short}), was #${index}`);
        setIndex(n);
        const c = choices[n];
        if (c && c.value !== value) onChange(c.value);
      }}
    />
  );
}
