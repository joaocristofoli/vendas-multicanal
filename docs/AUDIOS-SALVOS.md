# Áudios salvos

O painel permite gravar notas de voz, converter para OGG/Opus com FFmpeg, transcrever e criar
um atalho. No WhatsApp, o envio usa nota de voz nativa; outros canais só devem ser habilitados
quando tiverem entrega confirmada.

Arquivos ficam em `TIM_SAVED_AUDIO_DIR` e metadados no banco. Nada de áudio pertence ao Git.
Use apenas voz própria ou material com autorização explícita.

A IA não recebe nem envia áudios salvos por padrão. Depois de revisar transcrição, contexto e
destinatários, quem opera pode habilitar `saved_audio_ai` no painel. Um marcador só é aceito
quando corresponde a um áudio ativo e pronto; falhas de mídia não podem virar texto comum.
