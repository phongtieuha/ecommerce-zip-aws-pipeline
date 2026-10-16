Applies to: `**/*.tsx` under this package.

# TSX Component Authoring Rules

- Always use existing `shadcn/ui` components first when building UI.
- Before writing a new component, check whether an existing component already solves the requirement.
- If the needed shadcn component is missing, install and set it up following shadcn documentation.
- If a new custom component is still needed, confirm with the user first before adding it.
- When proposing a new custom component, explain clearly what the component does and why it is needed.
- Keep component props minimal. Avoid optional props unless they are required for current usage.
- Follow SOLID principles in component design and composition.

# TSX Styling Rules

- Always use Tailwind CSS utility classes for styling in TSX.
- Do not use inline styles such as style={{ ... }}.
- Do not hardcode style values in component code.
- Use only standard Tailwind classes generated from the design system scale.
- Do not introduce Tailwind arbitrary values (for example `w-[123px]`, `text-[13px]`, `bg-[#123456]`) unless the user explicitly provides those exact values.
- Prefer existing design tokens and utility classes for spacing, color, typography, sizing, and layout.
- If a needed style is missing, add or reuse a Tailwind class pattern instead of introducing inline CSS.
