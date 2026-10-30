# Grupo Virtus: o atendimento do WhatsApp é feito na Blip. O Chatwoot só acompanha (espelho).
# Bloqueia todo envio de mensagem escrita no Chatwoot para o WhatsApp: a mensagem fica como "falhou"
# com o motivo abaixo e nada sai para o cliente. Notas privadas não passam por aqui (nunca são enviadas),
# e as mensagens espelhadas pela ponte Blip já são ignoradas antes (têm source_id).
# Montado em /app/config/initializers/ pelos serviços rails e sidekiq (docker-compose.yml).
Rails.application.config.to_prepare do
  Whatsapp::SendOnWhatsappService.prepend(
    Module.new do
      private

      def perform_reply
        Rails.logger.info("[VIRTUS] Envio pelo Chatwoot bloqueado: message_id=#{message.id} conversation_id=#{message.conversation_id}")
        message.update!(status: :failed, external_error: 'Envio pelo Chatwoot bloqueado: responda pela Blip.')
      end
    end
  )
end
