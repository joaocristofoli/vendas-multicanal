# Conectar uma conta do Tinder

Use somente uma conta própria. O token do Tinder é uma credencial sensível: nunca o coloque em
arquivo versionado, issue, log ou mensagem.

Com `tinder.com` aberto e autenticado em um navegador dedicado, leia no console do DevTools:

```js
copy(localStorage.getItem('TinderWeb/APIToken'))
```

Cole o valor no campo de sessão do painel. A rota valida o perfil antes de salvar e registra a
identidade da conta. Confira nome e perfil exibidos; se não forem seus, cancele imediatamente.

Quando a sessão expirar, repita o procedimento. Um token encontrado automaticamente no Chrome
somente pode substituir o atual se pertencer à mesma conta já registrada. Mantenha o painel e a
porta de depuração do Chrome acessíveis apenas localmente.

Automação de swipe e resposta começa desligada. Ative apenas depois de revisar critérios,
rascunhos, limites e os termos atuais do Tinder.
