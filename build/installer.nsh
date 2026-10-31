; Libera o programa no firewall do Windows (só funciona quando o instalador roda como administrador;
; caso contrário o Windows pergunta na primeira vez que o programa abrir a porta).
!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Transmissao Igreja" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes profile=private,domain'
!macroend
!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Transmissao Igreja"'
!macroend
