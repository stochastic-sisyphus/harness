import type {
  RunResult,
  OutputContract,
  ArtifactRef,
  ArtifactRequirement,
  JsonSchema,
} from './types.js'

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

export class Validator {
  validate(result: RunResult, contract: OutputContract): ValidationResult {
    const errors: string[] = []

    if (contract.requiredArtifacts.length) {
      this.checkRequiredArtifacts(result.artifacts, contract.requiredArtifacts, errors)
    }

    if (contract.requiredFields.length) {
      this.checkRequiredFields(result.outputs, contract.requiredFields, errors)
    }

    if (Object.keys(contract.resultSchema).length) {
      this.checkResultSchema(result.outputs, contract.resultSchema, errors)
    }

    return { valid: errors.length === 0, errors }
  }

  private checkRequiredArtifacts(
    artifacts: ArtifactRef[],
    requirements: ArtifactRequirement[],
    errors: string[],
  ): void {
    const presentKinds = new Set(artifacts.map((a) => a.kind))
    for (const req of requirements) {
      if (req.required && !presentKinds.has(req.kind)) {
        errors.push(`Missing required artifact of kind "${req.kind}": ${req.description}`)
      }
    }
  }

  private checkRequiredFields(
    outputs: Record<string, unknown>,
    required: string[],
    errors: string[],
  ): void {
    for (const field of required) {
      if (!(field in outputs)) {
        errors.push(`Missing required output field: ${field}`)
      }
    }
  }

  /**
   * Basic JSON-schema-style validation: checks `required` and `properties.<key>.type`.
   * No external validator library — intentionally minimal.
   */
  private checkResultSchema(
    outputs: Record<string, unknown>,
    schema: JsonSchema,
    errors: string[],
  ): void {
    const requiredKeys = schema.required as string[] | undefined
    if (requiredKeys) {
      for (const key of requiredKeys) {
        if (!(key in outputs)) {
          errors.push(`Schema violation — missing required key: ${key}`)
        }
      }
    }

    const properties = schema.properties as
      | Record<string, { type?: string }>
      | undefined
    if (!properties) return

    for (const [key, def] of Object.entries(properties)) {
      if (!(key in outputs)) continue
      const expected = def.type
      if (!expected) continue

      const value = outputs[key]
      if (!matchesType(value, expected)) {
        errors.push(
          `Schema violation — "${key}" expected type "${expected}", got "${typeOf(value)}"`,
        )
      }
    }
  }
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function matchesType(value: unknown, expected: string): boolean {
  return typeOf(value) === expected
}
