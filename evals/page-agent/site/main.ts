import { mountScenario, type MountedScenario } from './scenarioRegistry'

declare global {
  interface Window {
    __WANDKIT_SCENARIO__: MountedScenario
  }
}

const app = document.querySelector<HTMLElement>('#app')
if (!app) throw new Error('找不到网页评估站点挂载节点 #app')

const scenarioId =
  new URLSearchParams(window.location.search).get('scenario') ?? 'read-data'

window.__WANDKIT_SCENARIO__ = mountScenario(scenarioId, app)
