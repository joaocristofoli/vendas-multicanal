// OS ATALHOS: o que dá pra digitar no self-chat (ou no painel) sem passar por modelo nenhum.
//
// O dono pediu: "se eu mandar `?` eu quero que o meu agente no whats ou no painel me responda
// os atalhos tipo modo normal ou modo codex — ou qualquer outro novo que tenhamos".
//
// A parte que importa é o "ou qualquer outro novo". Uma lista escrita à mão envelhece na
// primeira vez que alguém cria um atalho e esquece de atualizar o texto — e aí o `?` passa a
// mentir, que é pior que não existir. Então aqui a lista é um REGISTRO, e o teste
// (tests-tim/atalhos.mjs) passa cada `exemplo` pelo despachante DE VERDADE e confere que o
// efeito declarado acontece. Lista que mente quebra o build.
//
// Custo do `?`: zero token. É lido antes do modelo, como todo interruptor deste sistema —
// pelo mesmo motivo do "ia off": ajuda que depende do modelo estar de pé não serve quando
// você mais precisa dela.
import { getSetting } from '../core/db.mjs'
import { interruptorDeModo, modoAtual } from './codex-modo.mjs'
import { provedorAtivo } from '../ai/ia.mjs'

// Reconhece o pedido de ajuda. `?` sozinho é o principal; as outras formas existem porque
// ninguém lembra de qual é a palavra certa quando está com pressa.
export function pediuAjuda(texto) {
  const t = String(texto || '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/^[/!.]+/, '').replace(/\s+/g, ' ')
  return /^(\?|\?\?|ajuda|atalhos|comandos|menu|help|opcoes)$/.test(t)
}

// O REGISTRO. `exemplo` + `verifica` são o contrato com o teste: se o atalho parar de
// funcionar como está escrito aqui, a suíte reprova.
export const ATALHOS = [
  {
    chave: 'ia off',
    outrasFormas: ['ia desliga', 'ia pausa', '/ia off'],
    oQue: 'me desliga aqui no seu chat (eu paro de responder)',
    onde: 'sempre',
    exemplo: 'ia off',
    verifica: async () => (await import('./conversa.mjs')).interruptorDeTexto('ia off') === 'off',
  },
  {
    chave: 'ia on',
    outrasFormas: ['ia liga', 'ia volta'],
    oQue: 'me liga de volta. Funciona mesmo comigo desligado — é o freio de mão',
    onde: 'sempre',
    exemplo: 'ia on',
    verifica: async () => (await import('./conversa.mjs')).interruptorDeTexto('ia on') === 'on',
  },
  {
    chave: 'modo codex',
    outrasFormas: ['codex'],
    oQue: 'vira o agente que mexe no meu próprio código, dentro da VM',
    onde: 'normal',
    exemplo: 'modo codex',
    verifica: () => interruptorDeModo('modo codex') === 'codex',
  },
  {
    chave: 'modo normal',
    outrasFormas: ['codex off', 'codex sair'],
    oQue: 'volta pro assistente do dia a dia (agenda, pessoas, lembretes)',
    onde: 'codex',
    exemplo: 'modo normal',
    verifica: () => interruptorDeModo('modo normal') === 'assistente',
  },
  {
    chave: 'codex limpar',
    outrasFormas: ['codex novo', 'codex zerar'],
    oQue: 'esquece a conversa do códex e começa do zero',
    onde: 'codex',
    exemplo: 'codex limpar',
    verifica: () => interruptorDeModo('codex limpar') === 'limpar',
  },
  {
    chave: 'aplicar',
    outrasFormas: ['sobe', 'deploy'],
    oQue: 'roda a suíte inteira e, se passar, reinicia o vendas-multicanal com o que foi escrito',
    onde: 'codex',
    exemplo: 'aplicar',
    // o reconhecedor do "aplicar" mora no ciclo do modo códex; aqui só a forma
    verifica: () => /^(aplicar|aplica|sobe|subir|deploy)$/.test('aplicar'),
  },
  {
    chave: 'ia claude / ia openai',
    outrasFormas: ['ia codex'],
    oQue: 'troca QUAL IA roda tudo: o clone, o assistente, os extratores e o modo códex',
    onde: 'sempre',
    exemplo: 'ia claude',
    verifica: async () => (await import('./conversa.mjs')).interruptorDeIa('ia claude') === 'claude'
      && (await import('./conversa.mjs')).interruptorDeIa('ia openai') === 'codex',
  },
  {
    chave: '?',
    outrasFormas: ['ajuda', 'atalhos', 'comandos'],
    oQue: 'esta lista, com o estado de agora',
    onde: 'sempre',
    exemplo: '?',
    verifica: () => pediuAjuda('?'),
  },
]

// O estado agora — o que ele mais quer saber quando digita `?` é "em que pé eu tô".
export function estado() {
  const modo = modoAtual()
  return {
    modo,
    iaLigada: getSetting('assistente_enabled', true) !== false,
    ia: provedorAtivo(),
  }
}

// O texto da resposta. Curto, sem enfeite, e só com o que vale no modo atual — atalho que
// não funciona onde você está é ruído.
export function comoTexto() {
  const e = estado()
  const vale = (a) => a.onde === 'sempre' || a.onde === (e.modo === 'codex' ? 'codex' : 'normal')
  const linhas = [
    // Cada campo etiquetado: "modo normal, ligado" deixava no ar ligado o quê.
    `modo: ${e.modo === 'codex' ? 'CÓDEX (eu mexo no meu próprio código)' : 'normal (assistente do dia a dia)'}`,
    `eu: ${e.iaLigada ? 'ligado' : 'DESLIGADO'}`,
    `IA: ${e.ia === 'claude' ? 'Anthropic (Claude)' : 'OpenAI (Codex)'} — vale pro clone, pro assistente e pro códex`,
    '',
  ]
  for (const a of ATALHOS.filter(vale)) {
    linhas.push(`${a.chave} — ${a.oQue}`)
  }
  const outros = ATALHOS.filter((a) => !vale(a))
  if (outros.length) {
    linhas.push('')
    linhas.push(`no outro modo: ${outros.map((a) => a.chave).join(', ')}`)
  }
  linhas.push('')
  linhas.push('qualquer outra coisa é conversa comigo, normal')
  return linhas.join('\n')
}
