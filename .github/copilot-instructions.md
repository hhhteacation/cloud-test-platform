# Copilot instructions for this repository

This repository is an MVP for a Chinese enterprise-style SDK video compatibility testing platform.

## Project context
- Frontend: React 19 + TypeScript + Vite + Ant Design + Zustand.
- Main user flow: upload video → create task → select Android device → simulate execution → view logs → export report.
- Android demo integration lives under android/ and should keep SDK-specific logic in adapter classes rather than UI code.

## Working conventions
- Prefer small, focused changes that fit the existing page/component/store structure.
- Keep shared types in web/src/types and reusable helpers in web/src/utils.
- Use the existing Zustand store pattern for app state instead of introducing new state management layers.
- Preserve the enterprise-console visual style and the current route structure.
- Avoid adding dependencies unless they are clearly justified.

## Validation expectations
- When touching frontend logic, run pnpm test and pnpm build before considering the change complete.
- If Android-related code is changed, try ./android/gradlew -p android assembleDebug.
- Do not claim a fix is complete without fresh verification output.

## Scope guidance
- Web UI changes should usually go in web/src/pages, web/src/components, or web/src/stores.
- Simulation or runner behavior should stay in web/src/runner or the relevant adapter layer.
- Android changes should stay in the adapter classes under android/app/src/main/java unless a true platform integration change is required.
