import {
  Type,
  type SchemaOptions,
  type TLiteral,
  type TLiteralValue,
  type TUnion
} from '@sinclair/typebox'

export interface LabeledLiteralOption<TValue extends TLiteralValue = TLiteralValue> {
  readonly value: TValue
  readonly label: string
}

type LabeledLiteralOptions = readonly [
  LabeledLiteralOption,
  LabeledLiteralOption,
  ...LabeledLiteralOption[]
]

type LiteralSchemasFromOptions<TOptions extends LabeledLiteralOptions> = {
  -readonly [TIndex in keyof TOptions]:
    TOptions[TIndex] extends LabeledLiteralOption<infer TValue>
      ? TLiteral<TValue>
      : never
}

export function literalUnionFromOptions<TOptions extends LabeledLiteralOptions>(
  options: TOptions,
  schemaOptions?: SchemaOptions
): TUnion<LiteralSchemasFromOptions<TOptions>> {
  const literals = options.map(option => Type.Literal(option.value, {
    description: `${option.value}=${option.label}`
  })) as unknown as LiteralSchemasFromOptions<TOptions>
  return Type.Union(literals, schemaOptions) as TUnion<LiteralSchemasFromOptions<TOptions>>
}

type LabelMapOption = LabeledLiteralOption<string | number>
type LabelMapOptions = readonly [LabelMapOption, LabelMapOption, ...LabelMapOption[]]
type LabelsFromOptions<TOptions extends LabelMapOptions> = {
  readonly [TOption in TOptions[number] as TOption['value']]: TOption['label']
}

export function labelsFromOptions<TOptions extends LabelMapOptions>(
  options: TOptions
): LabelsFromOptions<TOptions> {
  const labels: Record<string | number, string> = {}
  options.forEach(option => {
    labels[option.value] = option.label
  })
  return labels as LabelsFromOptions<TOptions>
}
