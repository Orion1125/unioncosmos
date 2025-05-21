package cmd

import (
	"fmt"
	provergrpc "galois/grpc"
	provergrpcapi "galois/grpc/api/v3"
	"net"
	"os"
	"time"

	"github.com/consensys/gnark/logger"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"github.com/spf13/cobra"
	"golang.org/x/net/netutil"
	"google.golang.org/grpc"
	"google.golang.org/grpc/keepalive"
)

func ServeBls12381Cmd() *cobra.Command {
	var cmd = &cobra.Command{
		Short: "Expose the prover daemon to the network as a gRPC endpoint",
		Use:   "serve [uri]",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			r1csPath, err := cmd.Flags().GetString(flagR1CS)
			if err != nil {
				return err
			}
			pkPath, err := cmd.Flags().GetString(flagPK)
			if err != nil {
				return err
			}
			vkPath, err := cmd.Flags().GetString(flagVK)
			if err != nil {
				return err
			}
			maxConn, err := cmd.Flags().GetInt(flagMaxConn)
			if err != nil {
				return err
			}
			logLevel, err := cmd.Flags().GetInt(flagLogLevel)
			if err != nil {
				return err
			}
			if logLevel > int(zerolog.PanicLevel) || logLevel < int(zerolog.TraceLevel) {
				return fmt.Errorf("log level must be between TraceLevel and PanicLevel")
			}
			zerolog.SetGlobalLevel(zerolog.Level(logLevel))
			log.Logger = log.With().Caller().Logger().Output(os.Stdout)
			logger.Set(log.Logger)
			uri := args[0]
			lis, err := net.Listen("tcp", uri)
			if err != nil {
				return err
			}
			limitedLis := netutil.LimitListener(lis, maxConn)
			grpcServer := grpc.NewServer(grpc.KeepaliveParams(keepalive.ServerParameters{
				MaxConnectionIdle:     10 * time.Second,
				MaxConnectionAge:      5 * time.Minute,
				MaxConnectionAgeGrace: time.Second,
				Time:                  5 * time.Second,
				Timeout:               20 * time.Second,
			}))
			server, err := provergrpc.NewProverServer(uint32(maxConn), r1csPath, pkPath, vkPath)
			if err != nil {
				return err
			}
			provergrpcapi.RegisterUnionProverAPIServer(grpcServer, server)
			log.Info().Msg("Serving...")
			return grpcServer.Serve(limitedLis)
		},
	}
	cmd.Flags().String(flagR1CS, "r1cs.bin", "Path to the compiled R1CS circuit.")
	cmd.Flags().String(flagPK, "pk.bin", "Path to the proving key.")
	cmd.Flags().String(flagVK, "vk.bin", "Path to the verifying key.")
	cmd.Flags().Int(flagMaxConn, 1, "Maximum number of concurrent connection.")
	cmd.Flags().Int(flagLogLevel, int(zerolog.InfoLevel), "Log level see https://github.com/rs/zerolog/blob/c78e50e2da70f4ae63e1b65222c3acf12e9ba699/README.md#leveled-logging")
	return cmd
}
