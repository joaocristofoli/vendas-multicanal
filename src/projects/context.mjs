// Consciência dos projetos no cérebro: monta um bloco compacto com os projetos ATIVOS do
// o dono (nome, tipo, próximo passo, envolvidos) que entra no prompt de TODOS os canais. É
// aditivo/opt-in: sem projetos ativos (ou com a consciência desligada) devolve '' e o prompt
// fica byte-a-byte idêntico ao de antes. Espelha o agenda/context.mjs (agendaBlock).
import { listProjects, projectPeople } from './store.mjs'
import { db, getSetting } from '../core/db.mjs'

const CACHE_TTL_MS = 60 * 1000
let cache = { ts: 0, block: '' }

const TYPE_LABEL = { trabalho: 'trabalho', pessoal: 'pessoal', objetivo: 'objetivo' }

function nextStepFor(projectId) {
  const t = db().prepare(`SELECT title FROM task WHERE project_id=? AND is_next=1 AND done=0 LIMIT 1`).get(projectId)
    || db().prepare(`SELECT title FROM task WHERE project_id=? AND done=0 ORDER BY position ASC LIMIT 1`).get(projectId)
  return t?.title || null
}

// Bloco pronto pro prompt (ou '' quando não há projeto ativo / consciência desligada).
export function projectsBlock(accountKey = 'main') {
  if (!getSetting('projects_awareness', true)) return ''
  if (Date.now() - cache.ts < CACHE_TTL_MS) return cache.block
  const active = listProjects(accountKey).filter((p) => p.status === 'ativo')
  if (!active.length) { cache = { ts: Date.now(), block: '' }; return '' }
  const lines = active.slice(0, 12).map((p) => {
    const next = nextStepFor(p.id)
    const people = projectPeople(p.id, accountKey).map((x) => x.name).filter(Boolean).slice(0, 4)
    const bits = [`- ${p.name} (${TYPE_LABEL[p.type] || p.type})`]
    if (next) bits.push(`próximo passo: ${next}`)
    if (people.length) bits.push(`envolvidos: ${people.join(', ')}`)
    return bits.join(' — ')
  })
  const block = [
    'PROJETOS DO USUÁRIO (o que ele está tocando na vida; contexto sobre ELE, não sobre a pessoa da conversa).',
    'Use só quando criar conexão natural com o assunto: se a pessoa da conversa está envolvida num projeto, ou se o assunto encostar num deles. Nunca liste os projetos pra pessoa nem exponha detalhes de terceiros; fale como quem simplesmente sabe da própria vida.',
    lines.join('\n'),
  ].join('\n')
  cache = { ts: Date.now(), block }
  return block
}

// Invalida o cache (chamar quando projetos mudam, se quiser refletir na hora).
export function bustProjectsCache() { cache = { ts: 0, block: '' } }
