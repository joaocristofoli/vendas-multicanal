// QUEM FALA E COM QUEM FALA. Nenhum gênero é presumido na edição pública.
// Quando a pessoa configura os dois lados, o sistema usa duas camadas:
//   1. um FATO no topo do prompt (não é instrução de estilo — é quem são as pessoas)
//   2. uma trava depois da geração, que pega o feminino dirigido a um homem e manda
//      reescrever. Porque hoje já aprendemos, três vezes, que o prompt sozinho não segura.
import { getSetting } from '../core/db.mjs'
import { generoDonoDeclarado } from '../core/dono.mjs'

// 'f' | 'm' | 'x' (não declarado). A cópia pública nasce neutra.
export function generoDono() {
  const padrao = process.env.TIM_DONO_GENERO || generoDonoDeclarado() || 'x'
  return String(getSetting('dono_genero', padrao) || 'x').toLowerCase()
}
export function generoInterlocutor() {
  const padrao = process.env.TIM_INTERLOCUTOR_GENERO || 'x'
  return String(getSetting('interlocutor_genero', padrao) || 'x').toLowerCase()
}

const NOME = { f: 'mulher', m: 'homem', x: 'pessoa' }

export function blocoGenero() {
  const d = generoDono(); const i = generoInterlocutor()
  const concordancia = i === 'm'
    ? 'Trate a outra pessoa no MASCULINO em adjetivos, plurais e apelidos.'
    : i === 'f'
      ? 'Trate a outra pessoa no FEMININO em adjetivos, plurais e apelidos.'
      : 'O gênero da outra pessoa não foi declarado: prefira construções neutras e não adivinhe pronomes.'
  return [
    `QUEM É QUEM: você escreve como ${d === 'f' ? 'uma mulher' : d === 'm' ? 'um homem' : 'uma pessoa'}, e quem está do outro lado é ${i === 'f' ? 'uma mulher' : i === 'm' ? 'um homem' : 'uma pessoa de gênero não declarado'}.`,
    concordancia,
    'Onde outras instruções usarem "ela" ou "ele" como forma genérica, adapte à configuração acima.',
  ].join(' ')
}

// ---------------------------------------------------------------- a trava
// Só marca o que é INEQUÍVOCO e dirigido ao interlocutor. "Que casa linda" não pode ser
// barrado; "tu é linda" sim. Por isso quase tudo exige um marcador de segunda pessoa perto.
const SEGUNDA_PESSOA = '(tu|voce|vc|te|ti|contigo|teu|tua|seu|sua)'

// O vocativo só conta quando é DIRIGIDO a ele. "Que casa linda" e "minha amiga me contou"
// são português normal e não podem ser barrados — o primeiro elogia uma coisa, o segundo fala
// de uma terceira pessoa. Barrar isso deixaria a IA sem meia língua. Então exige: saudação
// antes ("oi linda"), a mensagem ser só o vocativo, ou possessivo colado ("minha linda").
const VOC_F = '(linda|gata|gatinha|princesa|amiga|miga|querida|gostosa|bela|amada|deusa)'
const FEMININO_PRA_ELE = [
  { re: new RegExp(`^(oi+|ola|opa|e ai|eae|bom dia|boa tarde|boa noite|hey)[ ,]+${VOC_F}\\b`), oQue: 'cumprimentou ele com vocativo feminino' },
  { re: new RegExp(`^${VOC_F}[ ,!?]*$`), oQue: 'chamou ele por um vocativo feminino' },
  { re: new RegExp(`\\b(minha|sua) ${VOC_F}\\b(?![ ]?(me|te|disse|falou|contou|mandou))`), oQue: 'chamou ele por um vocativo feminino' },
  // plural incluindo os dois
  { re: /\b(juntas|nos duas|nois duas|as duas|ambas)\b/, oQue: 'usou plural feminino pra vocês dois' },
  // adjetivo com segunda pessoa: "tu tá cansada", "vc é linda"
  { re: new RegExp(`\\b${SEGUNDA_PESSOA}\\b[^.!?]{0,25}\\b(cansada|linda|gostosa|bonita|sozinha|ocupada|apaixonada|animada|preocupada|brava|chata|fofa)\\b`), oQue: 'concordou um adjetivo no feminino com ele' },
  { re: new RegExp(`\\b(cansada|linda|gostosa|bonita|sozinha|apaixonada)\\b[^.!?]{0,15}\\b${SEGUNDA_PESSOA}\\b`), oQue: 'concordou um adjetivo no feminino com ele' },
]

const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

export function erroDeGenero(texto) {
  if (generoInterlocutor() !== 'm') return { erro: false }
  const t = norm(texto)
  if (!t.trim()) return { erro: false }
  for (const p of FEMININO_PRA_ELE) {
    const m = t.match(p.re)
    if (m) return { erro: true, motivo: `${p.oQue} ("${m[0].trim()}") — quem está do outro lado é homem` }
  }
  return { erro: false }
}

export function instrucaoDeGenero(v) {
  return `A resposta anterior ${v.motivo}. Reescreva tratando ele no MASCULINO em tudo: adjetivo, plural e apelido. Nada de "linda", "gata", "amiga", "querida" nem "juntas". Mantenha o resto igual.`
}
