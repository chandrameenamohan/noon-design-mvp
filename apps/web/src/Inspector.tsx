import { useId, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { Doc, DocNode, Manifest, Op, PropValue } from "@noon/contracts";
import { controlFor, glyphFor, spaceOf, splitProps, type Control, type Prop, type Space } from "./controls.ts";
import { sentenceFor } from "./reasons.ts";

/**
 * The inspector (E10.4): the manifest, rendered, in three sections. Component (the name, and where the node
 * goes: up, down, into a container, or away), Layout (the auto-layout props the manifest DECLARES for this
 * component, by name and kind: direction and align as arrow segments, gap and padding as steppers that shade
 * their space on the canvas while hovered or focused) and Props (everything else). One control per prop kind
 * (controls.ts): text, a number stepper (arrows ±1, Shift ×10), a switch, a segmented choice (a select past
 * four). An unset prop shows the manifest default as its placeholder or resting state; Reset sends set_prop
 * null, which removes it. Nothing is keyed on a component's name.
 *
 * It only BUILDS ops; whether an op is allowed is the replica's and the room's business. Their refusal comes
 * back as a notice like any other edit's, and is repeated beside the control it was about (`refusals`).
 *
 * Commit semantics, kept from E2.5b: a typed value (text or number) is sent when the person LEAVES the field
 * or presses Enter, one op per edit, never one per keystroke (a flood of set_prop would meet the room's rate
 * limit and fill the audit log). A choice, a switch, an arrow step and a stepper button are each ONE edit,
 * so they send at once.
 */
type Component = Manifest["components"][number];
type Reason = Parameters<typeof sentenceFor>[0];
type Value = PropValue | undefined;
type OnChange = (value: PropValue | null) => void;
/** A gap or padding control under the pointer or the focus: the canvas shades that space of the node. */
export type Hint = { nodeId: string; space: Space };

type Props = {
  doc: Doc;
  node: DocNode;
  label: string;
  component: Component | undefined;
  containers: { id: string; label: string }[];
  /** Why the last edit of a prop did not happen, by prop name; gone once dismissed or tried again. */
  refusals: ReadonlyMap<string, Reason>;
  submit: (op: Op) => void;
  onHint: (hint: Hint | null) => void;
};

/** Field-level ids: the control, and the refusal sentence it is described by while there is one. */
type Ids = { id: string; describedBy: string | undefined };

/** Turns -0 into 0: JSON cannot carry -0, so the contract refuses it. */
const plain = (n: number): number => n + 0;

function TextField({ control, value, ids, onChange }: { control: Extract<Control, { kind: "text" }>; value: Value; ids: Ids; onChange: OnChange }) {
  // The draft lives here only while the field has focus; the document stays the source of truth.
  const [draft, setDraft] = useState<string>();
  const commit = (): void => {
    if (draft === undefined) return;
    setDraft(undefined);
    onChange(draft === "" ? null : draft);
  };
  return <input id={ids.id} type="text" className="mono" aria-describedby={ids.describedBy} placeholder={control.placeholder} value={draft ?? (typeof value === "string" ? value : "")} onChange={(event) => { setDraft(event.target.value); }} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") commit(); }} />;
}

/**
 * A number with a stepper: typing commits on blur or Enter; Up/Down step by 1 (Shift: 10) from the shown
 * value (the draft, the prop, or the manifest default) and commit at once, as do the − and + buttons.
 * ponytail: no per-prop bounds, the manifest declares none (a `min`/`max` in the manifest would land here).
 */
function NumberField({ control, value, ids, onChange }: { control: Extract<Control, { kind: "number" }>; value: Value; ids: Ids; onChange: OnChange }) {
  const [draft, setDraft] = useState<string>();
  const name = control.prop.name;
  const resting = typeof value === "number" ? value : typeof control.prop.default === "number" ? control.prop.default : 0;
  const shown = draft !== undefined && draft !== "" && Number.isFinite(Number(draft)) ? Number(draft) : resting;
  const stepBy = (direction: 1 | -1, big: boolean): void => { setDraft(undefined); onChange(plain(shown + direction * (big ? 10 : 1))); };
  const commit = (input: HTMLInputElement): void => {
    if (draft === undefined) return;
    setDraft(undefined);
    // A number field reports "" BOTH when it is empty and when it holds text it cannot read ("1e999",
    // "12abc"). Only the browser knows which: validity.badInput. Unreadable = no edit; taking it for ""
    // would silently delete the prop.
    if (input.validity.badInput) return;
    if (draft === "") onChange(null);
    else if (Number.isFinite(Number(draft))) onChange(plain(Number(draft)));
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") commit(event.currentTarget);
    else if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); stepBy(event.key === "ArrowUp" ? 1 : -1, event.shiftKey); }
  };
  const press = (direction: 1 | -1) => (event: ReactMouseEvent): void => { stepBy(direction, event.shiftKey); };
  return (
    <span className="stepper">
      <button type="button" tabIndex={-1} aria-label={`Decrease ${name}`} onClick={press(-1)}>−</button>
      <input id={ids.id} type="number" className="mono" aria-describedby={ids.describedBy} placeholder={control.placeholder} value={draft ?? (typeof value === "number" ? String(value) : "")} onChange={(event) => { setDraft(event.target.value); }} onBlur={(event) => { commit(event.currentTarget); }} onKeyDown={onKeyDown} />
      <button type="button" tabIndex={-1} aria-label={`Increase ${name}`} onClick={press(1)}>+</button>
    </span>
  );
}

/** A switch: unset, it rests at the manifest default; the first flip sends the opposite. */
function Toggle({ control, value, ids, onChange }: { control: Extract<Control, { kind: "toggle" }>; value: Value; ids: Ids; onChange: OnChange }) {
  return <input id={ids.id} type="checkbox" role="switch" className="switch" aria-describedby={ids.describedBy} checked={typeof value === "boolean" ? value : control.fallback} onChange={(event) => { onChange(event.target.checked); }} />;
}

/**
 * Up to four options as one radio group (arrows move between them, a choice sends at once). The default
 * wears a dot while the prop is unset. An option flexbox names is drawn as its arrow; the name stays its label.
 * `ids.id` here is the element that NAMES the group (the field's name span).
 */
function Segmented({ control, value, ids, onChange }: { control: Extract<Control, { kind: "segmented" }>; value: Value; ids: Ids; onChange: OnChange }) {
  const group = useId();
  return (
    <fieldset role="radiogroup" className="segmented" aria-labelledby={ids.id} aria-describedby={ids.describedBy}>
      {control.options.map((option) => {
        const glyph = glyphFor(option);
        return (
          <label key={option} className="segment" data-default={value === undefined && option === control.fallback ? "" : undefined}>
            <input type="radio" name={group} value={option} checked={value === option} onChange={() => { onChange(option); }} />
            <span className="segment-face" aria-hidden={glyph !== undefined}>{glyph ?? option}</span>
            {glyph !== undefined && <span className="visually-hidden">{option}</span>}
          </label>
        );
      })}
    </fieldset>
  );
}

function Select({ control, value, ids, onChange }: { control: Extract<Control, { kind: "select" }>; value: Value; ids: Ids; onChange: OnChange }) {
  return (
    <select id={ids.id} className="mono" aria-describedby={ids.describedBy} value={typeof value === "string" ? value : ""} onChange={(event) => { onChange(event.target.value === "" ? null : event.target.value); }}>
      <option value="">{control.prop.required ? "(choose)" : control.fallback === undefined ? "(default)" : `(default: ${control.fallback})`}</option>
      {control.options.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
  );
}

/**
 * One prop: its label, its control, Reset while it is set (a required prop has no unset state, so none), the
 * default in words while it is not (the placeholder says it for text and numbers), and the refusal its last
 * edit met, if any. A segmented group is named by its legend, everything else by the label.
 */
function Field({ prop, value, refusal, onChange }: { prop: Prop; value: Value; refusal: Reason | undefined; onChange: OnChange }) {
  const id = useId();
  const nameId = `${id}-name`;
  const refusalId = `${id}-refusal`;
  const control = controlFor(prop);
  const ids: Ids = { id, describedBy: refusal === undefined ? undefined : refusalId };
  const isSet = value !== undefined;
  // A radio group is named by aria-labelledby (a fieldset's legend is not read the same way once it has a role); every other control by its label.
  const grouped = control.kind === "segmented";
  return (
    <div className="field" data-prop={prop.name} data-refused={refusal === undefined ? undefined : ""}>
      {grouped ? <span id={nameId} className="field-name">{prop.name}</span> : <label htmlFor={id}>{prop.name}</label>}
      <span className="field-control">
        {control.kind === "text" ? <TextField control={control} value={value} ids={ids} onChange={onChange} />
          : control.kind === "number" ? <NumberField control={control} value={value} ids={ids} onChange={onChange} />
            : control.kind === "toggle" ? <Toggle control={control} value={value} ids={ids} onChange={onChange} />
              : control.kind === "segmented" ? <Segmented control={control} value={value} ids={{ ...ids, id: nameId }} onChange={onChange} />
                : <Select control={control} value={value} ids={ids} onChange={onChange} />}
      </span>
      {isSet && !prop.required ? <button type="button" className="reset" aria-label={`Reset ${prop.name}`} onClick={() => { onChange(null); }}>Reset</button> : <span className="reset-space" />}
      {!isSet && (control.kind === "toggle" || control.kind === "segmented") && prop.default !== undefined && <span className="hint field-default">default {String(prop.default)}</span>}
      {refusal !== undefined && <span id={refusalId} className="field-refusal">{sentenceFor(refusal)}</span>}
    </div>
  );
}

/** A titled part of the inspector, a region of its own so a screen reader can jump between the three. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return <section aria-labelledby={id} className="inspector-section"><h3 id={id}>{title}</h3>{children}</section>;
}

export function Inspector({ doc, node, label, component, containers, refusals, submit, onHint }: Props) {
  const moveId = useId();
  const [target, setTarget] = useState("");
  const isRoot = node.parentId === null;
  const siblings = node.parentId === null ? [] : (doc.nodes[node.parentId]?.children ?? []);
  const at = siblings.indexOf(node.id);
  // `index` is where the node ENDS UP among its new siblings, counted after it was taken out (SPEC §2.4).
  const reorder = (to: number): void => { if (node.parentId !== null) submit({ type: "move_node", nodeId: node.id, newParentId: node.parentId, index: to }); };
  const { layout, props } = component ? splitProps(component) : { layout: [], props: [] };
  const valueOf = (prop: Prop): Value => (Object.hasOwn(node.props, prop.name) ? node.props[prop.name] : undefined);
  const field = (prop: Prop): ReactNode => <Field key={`${node.id}:${prop.name}`} prop={prop} value={valueOf(prop)} refusal={refusals.get(prop.name)} onChange={(value) => { submit({ type: "set_prop", nodeId: node.id, key: prop.name, value }); }} />;
  // The shade follows the pointer and the focus alike (every mouse action has a key path). Focus moving
  // between the stepper's own parts (the field and its buttons) is not a leave.
  const shading = (space: Space) => ({
    onPointerEnter: () => { onHint({ nodeId: node.id, space }); },
    onPointerLeave: () => { onHint(null); },
    onFocus: () => { onHint({ nodeId: node.id, space }); },
    onBlur: (event: ReactFocusEvent<HTMLDivElement>) => { if (!event.currentTarget.contains(event.relatedTarget)) onHint(null); },
  });

  return (
    <aside aria-label="Selected element" className="inspector">
      <h2>{label}</h2>
      {isRoot ? <p className="hint">Select an element to edit it. New elements are added to the page.</p> : (
        <>
          <Section title="Component">
            <p className="component-name"><code>{node.component}</code></p>
            <div className="inspector-actions">
              <button type="button" disabled={at <= 0} onClick={() => { reorder(at - 1); }}>Move up</button>
              <button type="button" disabled={at < 0 || at >= siblings.length - 1} onClick={() => { reorder(at + 1); }}>Move down</button>
              <button type="button" onClick={() => { submit({ type: "remove_node", nodeId: node.id }); }}>Remove</button>
            </div>
            <div className="field">
              <label htmlFor={moveId}>Move into</label>
              <span className="field-control">
                <select id={moveId} value={target} onChange={(event) => { setTarget(event.target.value); }}>
                  <option value="">(choose)</option>
                  {containers.filter((c) => c.id !== node.id).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </span>
              <button type="button" disabled={target === ""} onClick={() => { submit({ type: "move_node", nodeId: node.id, newParentId: target, index: doc.nodes[target]?.children.length ?? 0 }); setTarget(""); }}>Move</button>
            </div>
          </Section>
          <Section title="Layout">
            {layout.length === 0 ? <p className="hint">This component declares no layout properties.</p> : layout.map((prop) => {
              const space = spaceOf(prop);
              return space === undefined ? field(prop) : <div key={`${node.id}:${prop.name}`} className="shading" data-space={space} {...shading(space)}>{field(prop)}</div>;
            })}
          </Section>
          <Section title="Props">
            {props.length === 0 ? <p className="hint">No other properties.</p> : props.map((prop) => field(prop))}
          </Section>
        </>
      )}
    </aside>
  );
}
