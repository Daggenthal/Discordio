import { SliderField } from "@decky/ui";

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
  const index = Math.max(0, choices.findIndex((c) => c.value === value));
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
      notchLabels={choices.map((c, i) => ({ notchIndex: i, label: c.short, value: i }))}
      notchTicksVisible
      validValues="steps"
      showValue={false}
      onChange={(i) => {
        const c = choices[Math.round(i)];
        if (c && c.value !== value) onChange(c.value);
      }}
    />
  );
}
