import { useId, useState } from "react";
import type { Doc, DocNode, Manifest, Op } from "@noon/contracts";

type Component = Manifest["components"][number];
type Prop = Component["props"][number];
type Props = { doc: Doc; node: DocNode; label: string; component: Component | undefined; containers: { id: string; label: string }[]; submit: (op: Op) => void };

/**
 * One prop, as the control its TYPE asks for. The form is not written by hand: it is the manifest,
 * rendered. A text or number field sends its value when the user LEAVES it (one op per edit, not one
 * per keystroke); a choice sends at once. Clearing an optional prop sends null, which removes it.
 */
function PropField({ prop, value, onChange }: { prop: Prop; value: string | number | boolean | undefined; onChange: (value: string | number | boolean | null) => void }) {
  const id = useId();
  // The draft lives here only while the field has focus; the document stays the source of truth.
  const [draft, setDraft] = useState<string>();
  const label = <label htmlFor={id}>{prop.name}</label>;
  switch (prop.type.kind) {
    case "boolean":
      return <p>{label} <input id={id} type="checkbox" checked={value === true} onChange={(event) => { onChange(event.target.checked); }} /></p>;
    case "enum":
      return (
        <p>
          {label}{" "}
          <select id={id} value={typeof value === "string" ? value : ""} onChange={(event) => { onChange(event.target.value === "" ? null : event.target.value); }}>
            <option value="">{prop.required ? "(choose)" : "(default)"}</option>
            {prop.type.options.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </p>
      );
    case "number":
    case "string": {
      const isNumber = prop.type.kind === "number";
      const commit = (): void => {
        if (draft === undefined) return;
        setDraft(undefined);
        if (draft === "") onChange(null);
        else if (!isNumber) onChange(draft);
        else if (Number.isFinite(Number(draft))) onChange(Number(draft));
      };
      return (
        <p>
          {label}{" "}
          <input id={id} type={isNumber ? "number" : "text"} value={draft ?? (value === undefined ? "" : String(value))} onChange={(event) => { setDraft(event.target.value); }} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") commit(); }} />
        </p>
      );
    }
  }
}

/** Everything that can be done to the selected node. It only BUILDS ops; whether an op is allowed is the replica's and the room's business. */
export function Inspector({ doc, node, label, component, containers, submit }: Props) {
  const moveId = useId();
  const [target, setTarget] = useState("");
  const isRoot = node.parentId === null;
  const siblings = node.parentId === null ? [] : (doc.nodes[node.parentId]?.children ?? []);
  const at = siblings.indexOf(node.id);
  // `index` is where the node ENDS UP among its new siblings, counted after it was taken out (SPEC §2.4).
  const reorder = (to: number): void => { if (node.parentId !== null) submit({ type: "move_node", nodeId: node.id, newParentId: node.parentId, index: to }); };

  return (
    <aside aria-label="Selected element" className="inspector">
      <h2>{label}</h2>
      {isRoot ? <p>Select an element to edit it. New elements are added to the page.</p> : (
        <>
          {component?.props.map((prop) => (
            <PropField key={`${node.id}:${prop.name}`} prop={prop} value={Object.hasOwn(node.props, prop.name) ? node.props[prop.name] : undefined} onChange={(value) => { submit({ type: "set_prop", nodeId: node.id, key: prop.name, value }); }} />
          ))}
          <p>
            <button type="button" disabled={at <= 0} onClick={() => { reorder(at - 1); }}>Move up</button>{" "}
            <button type="button" disabled={at < 0 || at >= siblings.length - 1} onClick={() => { reorder(at + 1); }}>Move down</button>
          </p>
          <p>
            <label htmlFor={moveId}>Move into</label>{" "}
            <select id={moveId} value={target} onChange={(event) => { setTarget(event.target.value); }}>
              <option value="">(choose)</option>
              {containers.filter((c) => c.id !== node.id).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>{" "}
            <button type="button" disabled={target === ""} onClick={() => { submit({ type: "move_node", nodeId: node.id, newParentId: target, index: doc.nodes[target]?.children.length ?? 0 }); setTarget(""); }}>Move</button>
          </p>
          <p><button type="button" onClick={() => { submit({ type: "remove_node", nodeId: node.id }); }}>Remove</button></p>
        </>
      )}
    </aside>
  );
}
