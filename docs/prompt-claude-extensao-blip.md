Você vai me ajudar no portal da Blip (labrador.blip.ai), contrato "Kairos Treinamentos", em que já estou logado. A tarefa tem duas partes: primeiro encontrar o chatbot que atende o WhatsApp +55 48 9126-5138, depois adicionar um webhook nele.

REGRAS DE SEGURANÇA (obrigatórias):
1. Na PARTE 1 você só olha: não clique em Salvar, Excluir, Publicar, Ativar/Desativar nem em nada que altere configuração.
2. A ÚNICA alteração permitida é a da PARTE 2, e só depois de eu responder "pode salvar" no chat.
3. Não crie, copie, revele nem exiba chaves de acesso, tokens, senhas, "Authorization" ou segredos. Se uma tela mostrar algum, não transcreva.
4. Não apague nem edite webhooks, URLs, integrações, canais, fluxos, filas ou atendentes que já existam. Se já houver outras URLs no webhook, deixe todas como estão.
5. Não preencha OAuth 2.0 nem cabeçalhos customizados.
6. Não abra conversas de clientes nem copie dados pessoais (nomes, telefones, mensagens). Nos relatórios, mostre só nomes de bots e configurações.
7. Se aparecer algo inesperado (erro, pedido de senha, aviso de bloqueio ou cobrança), pare e me pergunte.

PARTE 1 — Encontrar o bot certo (só leitura):
a) Na lista de chatbots do contrato "Kairos Treinamentos", liste o nome de cada bot e se ele é um roteador (com sub-bots/serviços) ou um bot comum.
b) Em cada bot, abra Canais → WhatsApp e anote qual número está conectado, se houver.
c) Descubra qual bot tem o número +55 48 9126-5138. Se ele estiver num roteador, o bot certo é o ROTEADOR.
d) Observação: o bot "Wendell C" (identidade fluxoagentesredirect) NÃO é o certo. Ele só tem tráfego de teste.
e) Me mostre uma tabela (nome do bot | tipo | número do WhatsApp) e diga qual é o bot certo. Depois PARE e espere eu confirmar.

PARTE 2 — Adicionar o webhook (só depois de eu confirmar o bot e responder "pode salvar"):
a) No bot confirmado, vá em Integrações → Webhook.
b) Adicione um NOVO endereço, sem mexer nos que já existem:
   https://visualchat.wendellcarvalho.com.br/blip-webhook/<BLIP_WEBHOOK_PATH_TOKEN — ver .env no servidor>
c) Em Configurações avançadas → Tipos de envio, marque SOMENTE "Mensagens".
d) Deixe OAuth 2.0 e cabeçalhos customizados em branco.
e) Ligue a chave de ativação no canto superior direito.
f) Antes de clicar em Salvar, me mostre um resumo do que vai salvar e espere eu responder "pode salvar".
g) Depois de salvar, confirme que a URL aparece na lista, que a chave está ligada e que não há aviso de bloqueio abaixo da URL.

No final, me diga: o nome do bot em que o webhook foi configurado e se ele é roteador ou bot comum.
