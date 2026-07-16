"""
WavLM wrapper for speech emotion/stress detection.
Uses HuggingFace transformers with optional LoRA fine-tuning.
"""
import torch
import torch.nn as nn
from transformers import WavLMModel, WavLMConfig
import logging


class WavLMWrapper(nn.Module):
    """
    Wrapper for WavLM pretrained model with a classification head.
    Supports LoRA fine-tuning and various downstream architectures.
    """

    def __init__(self, args, output_class_num=2):
        super().__init__()
        self.args = args
        self.output_class_num = output_class_num

        # Load pretrained WavLM
        logging.info("Loading WavLM-Plus model...")
        try:
            # Try loading from HuggingFace
            # "main" resolves to an old commit with only pytorch_model.bin, which
            # transformers refuses to torch.load on torch<2.6 (CVE-2025-32434).
            # Pin to a commit that ships model.safetensors instead.
            self.wavlm = WavLMModel.from_pretrained(
                "microsoft/wavlm-large", revision="07d9d3d8576fd3d718ee7b16b2b6242e9610d9af"
            )
            self.hidden_size = 1024  # wavlm-large hidden size
        except Exception as e:
            logging.warning(f"Failed to load wavlm-large, trying wavlm-base: {e}")
            self.wavlm = WavLMModel.from_pretrained(
                "microsoft/wavlm-base-plus", revision="98fd61b9c652129c839c0a25a05987d8f59256a4"
            )
            self.hidden_size = 768  # wavlm-base hidden size

        # Freeze base model (we'll only train the head)
        if args.finetune_method == "lora":
            self._setup_lora()
        elif args.finetune_method == "full":
            logging.info("Full fine-tuning enabled")
        else:
            # Freeze everything by default
            for param in self.wavlm.parameters():
                param.requires_grad = False
            logging.info("Base model frozen - only training classification head")

        # Pooling layer
        self.pooling_type = args.pooling
        if self.pooling_type == "attn":
            self.attention_pooling = nn.Sequential(
                nn.Linear(self.hidden_size, 1),
                nn.Softmax(dim=1)
            )

        # Downstream classifier
        self.downstream = self._build_downstream(args)

        logging.info(f"WavLM wrapper initialized with {self.output_class_num} classes")

    def _setup_lora(self):
        """Setup LoRA fine-tuning if peft is available."""
        try:
            from peft import LoraConfig, get_peft_model

            # LoRA configuration
            lora_config = LoraConfig(
                r=self.args.lora_rank,
                lora_alpha=self.args.lora_rank * 2,
                #target_modules=["query", "value"],  # Apply LoRA to attention layers
                target_modules=["q_proj", "v_proj"],
                lora_dropout=0.1,
                bias="none",
               # task_type="SEQ_CLS"  # Sequence classification - FIXED!
            )

            # Apply LoRA
            self.wavlm = get_peft_model(self.wavlm, lora_config)
            self.wavlm.print_trainable_parameters()
            logging.info("LoRA fine-tuning enabled")

        except ImportError:
            logging.warning("peft not installed - freezing base model instead")
            for param in self.wavlm.parameters():
                param.requires_grad = False
            logging.info("Install peft with: pip install peft")
"""
WavLM wrapper for speech emotion/stress detection.
Uses HuggingFace transformers with optional LoRA fine-tuning.
"""
import torch
import torch.nn as nn
from transformers import WavLMModel, WavLMConfig
import logging


class WavLMWrapper(nn.Module):
    """
    Wrapper for WavLM pretrained model with a classification head.
    Supports LoRA fine-tuning and various downstream architectures.
    """

    def __init__(self, args, output_class_num=2):
        super().__init__()
        self.args = args
        self.output_class_num = output_class_num

        # Load pretrained WavLM
        logging.info("Loading WavLM-Plus model...")
        try:
            # Try loading from HuggingFace
            # "main" resolves to an old commit with only pytorch_model.bin, which
            # transformers refuses to torch.load on torch<2.6 (CVE-2025-32434).
            # Pin to a commit that ships model.safetensors instead.
            self.wavlm = WavLMModel.from_pretrained(
                "microsoft/wavlm-large", revision="07d9d3d8576fd3d718ee7b16b2b6242e9610d9af"
            )
            self.hidden_size = 1024  # wavlm-large hidden size
        except Exception as e:
            logging.warning(f"Failed to load wavlm-large, trying wavlm-base: {e}")
            self.wavlm = WavLMModel.from_pretrained(
                "microsoft/wavlm-base-plus", revision="98fd61b9c652129c839c0a25a05987d8f59256a4"
            )
            self.hidden_size = 768  # wavlm-base hidden size

        # Freeze base model (we'll only train the head)
        if args.finetune_method == "lora":
            self._setup_lora()
        elif args.finetune_method == "full":
            logging.info("Full fine-tuning enabled")
        else:
            # Freeze everything by default
            for param in self.wavlm.parameters():
                param.requires_grad = False
            logging.info("Base model frozen - only training classification head")

        # Pooling layer
        self.pooling_type = args.pooling
        if self.pooling_type == "attn":
            self.attention_pooling = nn.Sequential(
                nn.Linear(self.hidden_size, 1),
                nn.Softmax(dim=1)
            )

        # Downstream classifier
        self.downstream = self._build_downstream(args)

        logging.info(f"WavLM wrapper initialized with {self.output_class_num} classes")

    def _setup_lora(self):
        """Setup LoRA fine-tuning if peft is available."""
        try:
            from peft import LoraConfig, get_peft_model

            # LoRA configuration
            lora_config = LoraConfig(
                r=self.args.lora_rank,
                lora_alpha=self.args.lora_rank * 2,
                #target_modules=["query", "value"],  # Apply LoRA to attention layers
                target_modules=["q_proj", "v_proj"],
                lora_dropout=0.1,
                bias="none",
                #task_type="SEQ_CLS"  # Sequence classification - FIXED!
            )

            # Apply LoRA
            self.wavlm = get_peft_model(self.wavlm, lora_config)
            self.wavlm.print_trainable_parameters()
            logging.info("LoRA fine-tuning enabled")

        except ImportError:
            logging.warning("peft not installed - freezing base model instead")
            for param in self.wavlm.parameters():
                param.requires_grad = False
            logging.info("Install peft with: pip install peft")

    def _build_downstream(self, args):
        """Build the downstream classification head."""
        if args.downstream_model == "linear":
            return nn.Linear(self.hidden_size, self.output_class_num)

        elif args.downstream_model == "mlp":
            return nn.Sequential(
                nn.Linear(self.hidden_size, args.hidden_size),
                nn.ReLU(),
                nn.Dropout(0.1),
                nn.Linear(args.hidden_size, self.output_class_num)
            )

        elif args.downstream_model == "cnn":
            return nn.Sequential(
                nn.Conv1d(self.hidden_size, args.hidden_size, kernel_size=3, padding=1),
                nn.ReLU(),
                nn.AdaptiveAvgPool1d(1),
                nn.Flatten(),
                nn.Linear(args.hidden_size, self.output_class_num)
            )

        elif args.downstream_model == "rnn":
            self.rnn = nn.LSTM(
                self.hidden_size,
                args.hidden_size // 2,
                num_layers=args.num_layers,
                bidirectional=True,
                batch_first=True
            )
            return nn.Linear(args.hidden_size, self.output_class_num)

        else:
            # Default to linear
            return nn.Linear(self.hidden_size, self.output_class_num)

    def _pool_features(self, features, attention_mask=None):
        """
        Pool sequence features into a single vector.

        Args:
            features: [batch, seq_len, hidden_size]
            attention_mask: [batch, seq_len] (optional, usually None for WavLM)

        Returns:
            pooled: [batch, hidden_size]
        """
        if self.pooling_type == "mean":
            if attention_mask is not None:
                # Masked mean pooling
                mask_expanded = attention_mask.unsqueeze(-1).expand(features.size())
                sum_features = torch.sum(features * mask_expanded, dim=1)
                sum_mask = torch.clamp(mask_expanded.sum(dim=1), min=1e-9)
                return sum_features / sum_mask
            else:
                return features.mean(dim=1)

        elif self.pooling_type == "max":
            return features.max(dim=1)[0]

        elif self.pooling_type == "attn":
            # Attention-based pooling
            attn_weights = self.attention_pooling(features)  # [batch, seq_len, 1]
            if attention_mask is not None:
                attn_weights = attn_weights.masked_fill(attention_mask.unsqueeze(-1) == 0, -1e9)
                attn_weights = torch.softmax(attn_weights, dim=1)
            return (features * attn_weights).sum(dim=1)

        elif self.pooling_type == "stat":
            # Statistical pooling (mean + std)
            mean = features.mean(dim=1)
            std = features.std(dim=1)
            return torch.cat([mean, std], dim=-1)

        else:
            return features.mean(dim=1)

    def forward(self, x, length=None):
        """
        Forward pass.

        Args:
            x: Input waveform [batch, time]
            length: Length of each sample [batch]

        Returns:
            logits: [batch, num_classes]
        """
        batch_size = x.size(0)

        # Create attention mask from lengths (for raw audio)
        if length is not None:
            max_len = x.size(1)
            attention_mask = torch.arange(max_len, device=x.device).expand(batch_size, max_len)
            attention_mask = (attention_mask < length.unsqueeze(1)).long()
        else:
            attention_mask = None

        # Extract features from WavLM
        # WavLM handles attention masking internally and downsamples the sequence
        outputs = self.wavlm(x, attention_mask=attention_mask)
        features = outputs.last_hidden_state  # [batch, downsampled_seq_len, hidden_size]

        # Pool features - don't use attention_mask here since:
        # 1. WavLM already applied masking internally
        # 2. The dimensions don't match (features are downsampled)
        if self.pooling_type == "stat":
            pooled = self._pool_features(features, attention_mask=None)
            # For stat pooling, concatenate mean and std
            pooled = pooled.view(batch_size, -1)
        else:
            pooled = self._pool_features(features, attention_mask=None)

        # Apply downstream classifier"""
        # WavLM wrapper for speech emotion/stress detection.
        # Uses HuggingFace transformers with optional LoRA fine-tuning.
        # """
        # import torch
        # import torch.nn as nn
        # from transformers import WavLMModel, WavLMConfig
        # import logging
        #
        #
        # class WavLMWrapper(nn.Module):
        #     """
        #     Wrapper for WavLM pretrained model with a classification head.
        #     Supports LoRA fine-tuning and various downstream architectures.
        #     """
        #
        #     def __init__(self, args, output_class_num=2):
        #         super().__init__()
        #         self.args = args
        #         self.output_class_num = output_class_num
        #
        #         # Load pretrained WavLM
        #         logging.info("Loading WavLM-Plus model...")
        #         try:
        #             # Try loading from HuggingFace
        #             self.wavlm = WavLMModel.from_pretrained("microsoft/wavlm-large")
        #             self.hidden_size = 1024  # wavlm-large hidden size
        #         except Exception as e:
        #             logging.warning(f"Failed to load wavlm-large, trying wavlm-base: {e}")
        #             self.wavlm = WavLMModel.from_pretrained("microsoft/wavlm-base-plus")
        #             self.hidden_size = 768  # wavlm-base hidden size
        #
        #         # Freeze base model (we'll only train the head)
        #         if args.finetune_method == "lora":
        #             self._setup_lora()
        #         elif args.finetune_method == "full":
        #             logging.info("Full fine-tuning enabled")
        #         else:
        #             # Freeze everything by default
        #             for param in self.wavlm.parameters():
        #                 param.requires_grad = False
        #             logging.info("Base model frozen - only training classification head")
        #
        #         # Pooling layer
        #         self.pooling_type = args.pooling
        #         if self.pooling_type == "attn":
        #             self.attention_pooling = nn.Sequential(
        #                 nn.Linear(self.hidden_size, 1),
        #                 nn.Softmax(dim=1)
        #             )
        #
        #         # Downstream classifier
        #         self.downstream = self._build_downstream(args)
        #
        #         logging.info(f"WavLM wrapper initialized with {self.output_class_num} classes")
        #
        #     def _setup_lora(self):
        #         """Setup LoRA fine-tuning if peft is available."""
        #         try:
        #             from peft import LoraConfig, get_peft_model
        #
        #             # LoRA configuration
        #             lora_config = LoraConfig(
        #                 r=self.args.lora_rank,
        #                 lora_alpha=self.args.lora_rank * 2,
        #                 #target_modules=["query", "value"],  # Apply LoRA to attention layers
        #                 target_modules=["q_proj", "v_proj"],
        #                 lora_dropout=0.1,
        #                 bias="none",
        #                 task_type="SEQ_CLS"  # Sequence classification - FIXED!
        #             )
        #
        #             # Apply LoRA
        #             self.wavlm = get_peft_model(self.wavlm, lora_config)
        #             self.wavlm.print_trainable_parameters()
        #             logging.info("LoRA fine-tuning enabled")
        #
        #         except ImportError:
        #             logging.warning("peft not installed - freezing base model instead")
        #             for param in self.wavlm.parameters():
        #                 param.requires_grad = False
        #             logging.info("Install peft with: pip install peft")
        # """
        # WavLM wrapper for speech emotion/stress detection.
        # Uses HuggingFace transformers with optional LoRA fine-tuning.
        # """
        # import torch
        # import torch.nn as nn
        # from transformers import WavLMModel, WavLMConfig
        # import logging
        #
        #
        # class WavLMWrapper(nn.Module):
        #     """
        #     Wrapper for WavLM pretrained model with a classification head.
        #     Supports LoRA fine-tuning and various downstream architectures.
        #     """
        #
        #     def __init__(self, args, output_class_num=2):
        #         super().__init__()
        #         self.args = args
        #         self.output_class_num = output_class_num
        #
        #         # Load pretrained WavLM
        #         logging.info("Loading WavLM-Plus model...")
        #         try:
        #             # Try loading from HuggingFace
        #             self.wavlm = WavLMModel.from_pretrained("microsoft/wavlm-large")
        #             self.hidden_size = 1024  # wavlm-large hidden size
        #         except Exception as e:
        #             logging.warning(f"Failed to load wavlm-large, trying wavlm-base: {e}")
        #             self.wavlm = WavLMModel.from_pretrained("microsoft/wavlm-base-plus")
        #             self.hidden_size = 768  # wavlm-base hidden size
        #
        #         # Freeze base model (we'll only train the head)
        #         if args.finetune_method == "lora":
        #             self._setup_lora()
        #         elif args.finetune_method == "full":
        #             logging.info("Full fine-tuning enabled")
        #         else:
        #             # Freeze everything by default
        #             for param in self.wavlm.parameters():
        #                 param.requires_grad = False
        #             logging.info("Base model frozen - only training classification head")
        #
        #         # Pooling layer
        #         self.pooling_type = args.pooling
        #         if self.pooling_type == "attn":
        #             self.attention_pooling = nn.Sequential(
        #                 nn.Linear(self.hidden_size, 1),
        #                 nn.Softmax(dim=1)
        #             )
        #
        #         # Downstream classifier
        #         self.downstream = self._build_downstream(args)
        #
        #         logging.info(f"WavLM wrapper initialized with {self.output_class_num} classes")
        #
        #     def _setup_lora(self):
        #         """Setup LoRA fine-tuning if peft is available."""
        #         try:
        #             from peft import LoraConfig, get_peft_model
        #
        #             # LoRA configuration
        #             lora_config = LoraConfig(
        #                 r=self.args.lora_rank,
        #                 lora_alpha=self.args.lora_rank * 2,
        #                 #target_modules=["query", "value"],  # Apply LoRA to attention layers
        #                 target_modules=["q_proj", "v_proj"],
        #                 lora_dropout=0.1,
        #                 bias="none",
        #                 task_type="SEQ_CLS"  # Sequence classification - FIXED!
        #             )
        #
        #             # Apply LoRA
        #             self.wavlm = get_peft_model(self.wavlm, lora_config)
        #             self.wavlm.print_trainable_parameters()
        #             logging.info("LoRA fine-tuning enabled")
        #
        #         except ImportError:
        #             logging.warning("peft not installed - freezing base model instead")
        #             for param in self.wavlm.parameters():
        #                 param.requires_grad = False
        #             logging.info("Install peft with: pip install peft")
        #
        #     def _build_downstream(self, args):
        #         """Build the downstream classification head."""
        #         if args.downstream_model == "linear":
        #             return nn.Linear(self.hidden_size, self.output_class_num)
        #
        #         elif args.downstream_model == "mlp":
        #             return nn.Sequential(
        #                 nn.Linear(self.hidden_size, args.hidden_size),
        #                 nn.ReLU(),
        #                 nn.Dropout(0.1),
        #                 nn.Linear(args.hidden_size, self.output_class_num)
        #             )
        #
        #         elif args.downstream_model == "cnn":
        #             return nn.Sequential(
        #                 nn.Conv1d(self.hidden_size, args.hidden_size, kernel_size=3, padding=1),
        #                 nn.ReLU(),
        #                 nn.AdaptiveAvgPool1d(1),
        #                 nn.Flatten(),
        #                 nn.Linear(args.hidden_size, self.output_class_num)
        #             )
        #
        #         elif args.downstream_model == "rnn":
        #             self.rnn = nn.LSTM(
        #                 self.hidden_size,
        #                 args.hidden_size // 2,
        #                 num_layers=args.num_layers,
        #                 bidirectional=True,
        #                 batch_first=True
        #             )
        #             return nn.Linear(args.hidden_size, self.output_class_num)
        #
        #         else:
        #             # Default to linear
        #             return nn.Linear(self.hidden_size, self.output_class_num)
        #
        #     def _pool_features(self, features, attention_mask=None):
        #         """
        #         Pool sequence features into a single vector.
        #
        #         Args:
        #             features: [batch, seq_len, hidden_size]
        #             attention_mask: [batch, seq_len] (optional, usually None for WavLM)
        #
        #         Returns:
        #             pooled: [batch, hidden_size]
        #         """
        #         if self.pooling_type == "mean":
        #             if attention_mask is not None:
        #                 # Masked mean pooling
        #                 mask_expanded = attention_mask.unsqueeze(-1).expand(features.size())
        #                 sum_features = torch.sum(features * mask_expanded, dim=1)
        #                 sum_mask = torch.clamp(mask_expanded.sum(dim=1), min=1e-9)
        #                 return sum_features / sum_mask
        #             else:
        #                 return features.mean(dim=1)
        #
        #         elif self.pooling_type == "max":
        #             return features.max(dim=1)[0]
        #
        #         elif self.pooling_type == "attn":
        #             # Attention-based pooling
        #             attn_weights = self.attention_pooling(features)  # [batch, seq_len, 1]
        #             if attention_mask is not None:
        #                 attn_weights = attn_weights.masked_fill(attention_mask.unsqueeze(-1) == 0, -1e9)
        #                 attn_weights = torch.softmax(attn_weights, dim=1)
        #             return (features * attn_weights).sum(dim=1)
        #
        #         elif self.pooling_type == "stat":
        #             # Statistical pooling (mean + std)
        #             mean = features.mean(dim=1)
        #             std = features.std(dim=1)
        #             return torch.cat([mean, std], dim=-1)
        #
        #         else:
        #             return features.mean(dim=1)
        #
        #     def forward(self, x, length=None):
        #         """
        #         Forward pass.
        #
        #         Args:
        #             x: Input waveform [batch, time]
        #             length: Length of each sample [batch]
        #
        #         Returns:
        #             logits: [batch, num_classes]
        #         """
        #         batch_size = x.size(0)
        #
        #         # Create attention mask from lengths (for raw audio)
        #         if length is not None:
        #             max_len = x.size(1)
        #             attention_mask = torch.arange(max_len, device=x.device).expand(batch_size, max_len)
        #             attention_mask = (attention_mask < length.unsqueeze(1)).long()
        #         else:
        #             attention_mask = None
        #
        #         # Extract features from WavLM
        #         # WavLM handles attention masking internally and downsamples the sequence
        #         outputs = self.wavlm(x, attention_mask=attention_mask)
        #         features = outputs.last_hidden_state  # [batch, downsampled_seq_len, hidden_size]
        #
        #         # Pool features - don't use attention_mask here since:
        #         # 1. WavLM already applied masking internally
        #         # 2. The dimensions don't match (features are downsampled)
        #         if self.pooling_type == "stat":
        #             pooled = self._pool_features(features, attention_mask=None)
        #             # For stat pooling, concatenate mean and std
        #             pooled = pooled.view(batch_size, -1)
        #         else:
        #             pooled = self._pool_features(features, attention_mask=None)
        #
        #         # Apply downstream classifier
        #         if self.args.downstream_model == "rnn":
        #             # For RNN, we need sequence features
        #             rnn_out, _ = self.rnn(features)
        #             pooled = rnn_out.mean(dim=1)
        #             logits = self.downstream(pooled)
        #         elif self.args.downstream_model == "cnn":
        #             # For CNN, transpose to [batch, channels, seq_len]
        #             features_t = features.transpose(1, 2)
        #             logits = self.downstream(features_t)
        #         else:
        #             logits = self.downstream(pooled)
        #
        #         return logits
        #
        #
        # if __name__ == "__main__":
        #     """Test the wrapper."""
        #     import argparse
        #
        #     # Create dummy args
        #     args = argparse.Namespace(
        #         finetune_method="freeze",
        #         lora_rank=16,
        #         pooling="mean",
        #         downstream_model="linear",
        #         hidden_size=256,
        #         num_layers=2
        #     )
        #
        #     # Create model
        #     model = WavLMWrapper(args, output_class_num=2)
        #
        #     # Test forward pass
        #     batch_size = 4
        #     seq_len = 16000 * 3  # 3 seconds at 16kHz
        #     dummy_input = torch.randn(batch_size, seq_len)
        #     dummy_length = torch.tensor([seq_len, seq_len // 2, seq_len // 3, seq_len])
        #
        #     with torch.no_grad():
        #         logits = model(dummy_input, dummy_length)
        #
        #     print(f"Input shape: {dummy_input.shape}")
        #     print(f"Output logits shape: {logits.shape}")
        #     print(f"Output logits: {logits}")
        #     print("\n✓ WavLM wrapper test passed!")
        #
        #     def _build_downstream(self, args):
        #         """Build the downstream classification head."""
        #         if args.downstream_model == "linear":
        #             return nn.Linear(self.hidden_size, self.output_class_num)
        #
        #         elif args.downstream_model == "mlp":
        #             return nn.Sequential(
        #                 nn.Linear(self.hidden_size, args.hidden_size),
        #                 nn.ReLU(),
        #                 nn.Dropout(0.1),
        #                 nn.Linear(args.hidden_size, self.output_class_num)
        #             )
        #
        #         elif args.downstream_model == "cnn":
        #             return nn.Sequential(
        #                 nn.Conv1d(self.hidden_size, args.hidden_size, kernel_size=3, padding=1),
        #                 nn.ReLU(),
        #                 nn.AdaptiveAvgPool1d(1),
        #                 nn.Flatten(),
        #                 nn.Linear(args.hidden_size, self.output_class_num)
        #             )
        #
        #         elif args.downstream_model == "rnn":
        #             self.rnn = nn.LSTM(
        #                 self.hidden_size,
        #                 args.hidden_size // 2,
        #                 num_layers=args.num_layers,
        #                 bidirectional=True,
        #                 batch_first=True
        #             )
        #             return nn.Linear(args.hidden_size, self.output_class_num)
        #
        #         else:
        #             # Default to linear
        #             return nn.Linear(self.hidden_size, self.output_class_num)
        #
        #     def _pool_features(self, features, attention_mask=None):
        #         """
        #         Pool sequence features into a single vector.
        #
        #         Args:
        #             features: [batch, seq_len, hidden_size]
        #             attention_mask: [batch, seq_len] (optional, usually None for WavLM)
        #
        #         Returns:
        #             pooled: [batch, hidden_size]
        #         """
        #         if self.pooling_type == "mean":
        #             if attention_mask is not None:
        #                 # Masked mean pooling
        #                 mask_expanded = attention_mask.unsqueeze(-1).expand(features.size())
        #                 sum_features = torch.sum(features * mask_expanded, dim=1)
        #                 sum_mask = torch.clamp(mask_expanded.sum(dim=1), min=1e-9)
        #                 return sum_features / sum_mask
        #             else:
        #                 return features.mean(dim=1)
        #
        #         elif self.pooling_type == "max":
        #             return features.max(dim=1)[0]
        #
        #         elif self.pooling_type == "attn":
        #             # Attention-based pooling
        #             attn_weights = self.attention_pooling(features)  # [batch, seq_len, 1]
        #             if attention_mask is not None:
        #                 attn_weights = attn_weights.masked_fill(attention_mask.unsqueeze(-1) == 0, -1e9)
        #                 attn_weights = torch.softmax(attn_weights, dim=1)
        #             return (features * attn_weights).sum(dim=1)
        #
        #         elif self.pooling_type == "stat":
        #             # Statistical pooling (mean + std)
        #             mean = features.mean(dim=1)
        #             std = features.std(dim=1)
        #             return torch.cat([mean, std], dim=-1)
        #
        #         else:
        #             return features.mean(dim=1)
        #
        #     def forward(self, x, length=None):
        #         """
        #         Forward pass.
        #
        #         Args:
        #             x: Input waveform [batch, time]
        #             length: Length of each sample [batch]
        #
        #         Returns:
        #             logits: [batch, num_classes]
        #         """
        #         batch_size = x.size(0)
        #
        #         # Create attention mask from lengths (for raw audio)
        #         if length is not None:
        #             max_len = x.size(1)
        #             attention_mask = torch.arange(max_len, device=x.device).expand(batch_size, max_len)
        #             attention_mask = (attention_mask < length.unsqueeze(1)).long()
        #         else:
        #             attention_mask = None
        #
        #         # Extract features from WavLM
        #         # WavLM handles attention masking internally and downsamples the sequence
        #         outputs = self.wavlm(x, attention_mask=attention_mask)
        #         features = outputs.last_hidden_state  # [batch, downsampled_seq_len, hidden_size]
        #
        #         # Pool features - don't use attention_mask here since:
        #         # 1. WavLM already applied masking internally
        #         # 2. The dimensions don't match (features are downsampled)
        #         if self.pooling_type == "stat":
        #             pooled = self._pool_features(features, attention_mask=None)
        #             # For stat pooling, concatenate mean and std
        #             pooled = pooled.view(batch_size, -1)
        #         else:
        #             pooled = self._pool_features(features, attention_mask=None)
        #
        #         # Apply downstream classifier
        #         if self.args.downstream_model == "rnn":
        #             # For RNN, we need sequence features
        #             rnn_out, _ = self.rnn(features)
        #             pooled = rnn_out.mean(dim=1)
        #             logits = self.downstream(pooled)
        #         elif self.args.downstream_model == "cnn":
        #             # For CNN, transpose to [batch, channels, seq_len]
        #             features_t = features.transpose(1, 2)
        #             logits = self.downstream(features_t)
        #         else:
        #             logits = self.downstream(pooled)
        #
        #         return logits
        #
        #
        # if __name__ == "__main__":
        #     """Test the wrapper."""
        #     import argparse
        #
        #     # Create dummy args
        #     args = argparse.Namespace(
        #         finetune_method="freeze",
        #         lora_rank=16,
        #         pooling="mean",
        #         downstream_model="linear",
        #         hidden_size=256,
        #         num_layers=2
        #     )
        #
        #     # Create model
        #     model = WavLMWrapper(args, output_class_num=2)
        #
        #     # Test forward pass
        #     batch_size = 4
        #     seq_len = 16000 * 3  # 3 seconds at 16kHz
        #     dummy_input = torch.randn(batch_size, seq_len)
        #     dummy_length = torch.tensor([seq_len, seq_len // 2, seq_len // 3, seq_len])
        #
        #     with torch.no_grad():
        #         logits = model(dummy_input, dummy_length)
        #
        #     print(f"Input shape: {dummy_input.shape}")
        #     print(f"Output logits shape: {logits.shape}")
        #     print(f"Output logits: {logits}")
        #     print("\n✓ WavLM wrapper test passed!")
        if self.args.downstream_model == "rnn":
            # For RNN, we need sequence features
            rnn_out, _ = self.rnn(features)
            pooled = rnn_out.mean(dim=1)
            logits = self.downstream(pooled)
        elif self.args.downstream_model == "cnn":
            # For CNN, transpose to [batch, channels, seq_len]
            features_t = features.transpose(1, 2)
            logits = self.downstream(features_t)
        else:
            logits = self.downstream(pooled)

        return logits


if __name__ == "__main__":
    """Test the wrapper."""
    import argparse

    # Create dummy args
    args = argparse.Namespace(
        finetune_method="freeze",
        lora_rank=16,
        pooling="mean",
        downstream_model="linear",
        hidden_size=256,
        num_layers=2
    )

    # Create model
    model = WavLMWrapper(args, output_class_num=2)

    # Test forward pass
    batch_size = 4
    seq_len = 16000 * 3  # 3 seconds at 16kHz
    dummy_input = torch.randn(batch_size, seq_len)
    dummy_length = torch.tensor([seq_len, seq_len // 2, seq_len // 3, seq_len])

    with torch.no_grad():
        logits = model(dummy_input, dummy_length)

    print(f"Input shape: {dummy_input.shape}")
    print(f"Output logits shape: {logits.shape}")
    print(f"Output logits: {logits}")
    print("\n✓ WavLM wrapper test passed!")

    def _build_downstream(self, args):
        """Build the downstream classification head."""
        if args.downstream_model == "linear":
            return nn.Linear(self.hidden_size, self.output_class_num)

        elif args.downstream_model == "mlp":
            return nn.Sequential(
                nn.Linear(self.hidden_size, args.hidden_size),
                nn.ReLU(),
                nn.Dropout(0.1),
                nn.Linear(args.hidden_size, self.output_class_num)
            )

        elif args.downstream_model == "cnn":
            return nn.Sequential(
                nn.Conv1d(self.hidden_size, args.hidden_size, kernel_size=3, padding=1),
                nn.ReLU(),
                nn.AdaptiveAvgPool1d(1),
                nn.Flatten(),
                nn.Linear(args.hidden_size, self.output_class_num)
            )

        elif args.downstream_model == "rnn":
            self.rnn = nn.LSTM(
                self.hidden_size,
                args.hidden_size // 2,
                num_layers=args.num_layers,
                bidirectional=True,
                batch_first=True
            )
            return nn.Linear(args.hidden_size, self.output_class_num)

        else:
            # Default to linear
            return nn.Linear(self.hidden_size, self.output_class_num)

    def _pool_features(self, features, attention_mask=None):
        """
        Pool sequence features into a single vector.

        Args:
            features: [batch, seq_len, hidden_size]
            attention_mask: [batch, seq_len] (optional, usually None for WavLM)

        Returns:
            pooled: [batch, hidden_size]
        """
        if self.pooling_type == "mean":
            if attention_mask is not None:
                # Masked mean pooling
                mask_expanded = attention_mask.unsqueeze(-1).expand(features.size())
                sum_features = torch.sum(features * mask_expanded, dim=1)
                sum_mask = torch.clamp(mask_expanded.sum(dim=1), min=1e-9)
                return sum_features / sum_mask
            else:
                return features.mean(dim=1)

        elif self.pooling_type == "max":
            return features.max(dim=1)[0]

        elif self.pooling_type == "attn":
            # Attention-based pooling
            attn_weights = self.attention_pooling(features)  # [batch, seq_len, 1]
            if attention_mask is not None:
                attn_weights = attn_weights.masked_fill(attention_mask.unsqueeze(-1) == 0, -1e9)
                attn_weights = torch.softmax(attn_weights, dim=1)
            return (features * attn_weights).sum(dim=1)

        elif self.pooling_type == "stat":
            # Statistical pooling (mean + std)
            mean = features.mean(dim=1)
            std = features.std(dim=1)
            return torch.cat([mean, std], dim=-1)

        else:
            return features.mean(dim=1)

    def forward(self, x, length=None):
        """
        Forward pass.

        Args:
            x: Input waveform [batch, time]
            length: Length of each sample [batch]

        Returns:
            logits: [batch, num_classes]
        """
        batch_size = x.size(0)

        # Create attention mask from lengths (for raw audio)
        if length is not None:
            max_len = x.size(1)
            attention_mask = torch.arange(max_len, device=x.device).expand(batch_size, max_len)
            attention_mask = (attention_mask < length.unsqueeze(1)).long()
        else:
            attention_mask = None

        # Extract features from WavLM
        # WavLM handles attention masking internally and downsamples the sequence
        outputs = self.wavlm(x, attention_mask=attention_mask)
        features = outputs.last_hidden_state  # [batch, downsampled_seq_len, hidden_size]

        # Pool features - don't use attention_mask here since:
        # 1. WavLM already applied masking internally
        # 2. The dimensions don't match (features are downsampled)
        if self.pooling_type == "stat":
            pooled = self._pool_features(features, attention_mask=None)
            # For stat pooling, concatenate mean and std
            pooled = pooled.view(batch_size, -1)
        else:
            pooled = self._pool_features(features, attention_mask=None)

        # Apply downstream classifier
        if self.args.downstream_model == "rnn":
            # For RNN, we need sequence features
            rnn_out, _ = self.rnn(features)
            pooled = rnn_out.mean(dim=1)
            logits = self.downstream(pooled)
        elif self.args.downstream_model == "cnn":
            # For CNN, transpose to [batch, channels, seq_len]
            features_t = features.transpose(1, 2)
            logits = self.downstream(features_t)
        else:
            logits = self.downstream(pooled)

        return logits


if __name__ == "__main__":
    """Test the wrapper."""
    import argparse

    # Create dummy args
    args = argparse.Namespace(
        finetune_method="freeze",
        lora_rank=16,
        pooling="mean",
        downstream_model="linear",
        hidden_size=256,
        num_layers=2
    )

    # Create model
    model = WavLMWrapper(args, output_class_num=2)

    # Test forward pass
    batch_size = 4
    seq_len = 16000 * 3  # 3 seconds at 16kHz
    dummy_input = torch.randn(batch_size, seq_len)
    dummy_length = torch.tensor([seq_len, seq_len // 2, seq_len // 3, seq_len])

    with torch.no_grad():
        logits = model(dummy_input, dummy_length)

    print(f"Input shape: {dummy_input.shape}")
    print(f"Output logits shape: {logits.shape}")
    print(f"Output logits: {logits}")
    print("\n✓ WavLM wrapper test passed!")