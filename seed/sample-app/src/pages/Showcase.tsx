import { Button, Card, Image, Input, Stack, Text } from "../design-system/index.ts";

/** Every component once. Hand-written; pages the canvas generates will sit next to this file. */
export function Showcase() {
  return (
    <Stack direction="row" gap={16} align="start">
      <Card title="Order">
        <Stack gap={8}>
          <Text value="2 items" tone="muted" />
          <Image src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="" width={120} height={80} />
          <Button label="Edit" variant="ghost" />
        </Stack>
      </Card>
      <Card title="Pay">
        <Stack gap={12}>
          <Input label="Card number" placeholder="4242 4242 4242 4242" />
          <Button label="Pay $42" />
        </Stack>
      </Card>
    </Stack>
  );
}
