"""
Whisper wrapper for speech emotion/stress detection.
Uses HuggingFace transformers with optional LoRA fine-tuning.
"""
import torch
import torch.nn as nn
from transformers import WhisperModel
import logging


class WhisperWrapper(nn.Module):
    """
    Wrapper for Whisper pretrained model with a classification head.
    """

    def __init__(self, args, output_class_num=2):
        super().__init__()
        self.args = args
        self.output_class_num = output_class_num

        # Map model names
        model_map = {
            "whisper_tiny": "openai/whisper-tiny",
            "whisper_base": "openai/whisper-base",
            "whisper_small": "openai/whisper-small",
            "whisper_medium": "openai/whisper-medium",
            "whisper_large": "openai/whisper-large-v2"
        }

        model_name = model_map.get(args.pretrain_model, "openai/whisper-base")

        # Load pretrained Whisper
        logging.info(f"Loading {model_name} model...")
        try:
            self.whisper = WhisperModel.from_pretrained(model_name)

            # Hidden sizes for different Whisper models
            hidden_size_map = {
                "openai/whisper-tiny": 384,
                "openai/whisper-base": 512,
                "openai/whisper-small": 768,
                "openai/whisper-medium": 1024,
                "openai/whisper-large-v2": 1280
            }
            self.hidden_size = hidden_size_map.get(model_name, 512)

        except Exception as e:
            logging.error(f"Failed to load {model_name}: {e}")
            raise

        # Freeze base model
        if args.finetune_method == "lora":
            self._setup_lora()
        elif args.finetune_method == "full":
            logging.info("Full fine-tuning enabled")
        else:
            for param in self.whisper.parameters():
                param.requires_grad = False
            logging.info("Base model frozen - only training classification head")

        # Pooling
        self.pooling_type = args.pooling
        if self.pooling_type == "attn":
            self.attention_pooling = nn.Sequential(
                nn.Linear(self.hidden_size, 1),
                nn.Softmax(dim=1)
            )

        # Downstream classifier
        self.downstream = self._build_downstream(args)

        logging.info(f"Whisper wrapper initialized with {self.output_class_num} classes")

    def _setup_lora(self):
        """Setup LoRA fine-tuning if peft is available."""
        try:
            from peft import LoraConfig, get_peft_model

            lora_config = LoraConfig(
                r=self.args.lora_rank,
                lora_alpha=self.args.lora_rank * 2,
                target_modules=["q_proj", "v_proj"],
                lora_dropout=0.1,
                bias="none",
                task_type="AUDIO_CLASSIFICATION"
            )

            self.whisper = get_peft_model(self.whisper, lora_config)
            self.whisper.print_trainable_parameters()
            logging.info("LoRA fine-tuning enabled")

        except ImportError:
            logging.warning("peft not installed - freezing base model instead")
            for param in self.whisper.parameters():
                param.requires_grad = False

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

        else:
            return nn.Linear(self.hidden_size, self.output_class_num)

    def _pool_features(self, features, attention_mask=None):
        """Pool sequence features into a single vector."""
        if self.pooling_type == "mean":
            if attention_mask is not None:
                mask_expanded = attention_mask.unsqueeze(-1).expand(features.size())
                sum_features = torch.sum(features * mask_expanded, dim=1)
                sum_mask = torch.clamp(mask_expanded.sum(dim=1), min=1e-9)
                return sum_features / sum_mask
            else:
                return features.mean(dim=1)

        elif self.pooling_type == "max":
            return features.max(dim=1)[0]

        elif self.pooling_type == "attn":
            attn_weights = self.attention_pooling(features)
            if attention_mask is not None:
                attn_weights = attn_weights.masked_fill(attention_mask.unsqueeze(-1) == 0, -1e9)
                attn_weights = torch.softmax(attn_weights, dim=1)
            return (features * attn_weights).sum(dim=1)

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

        # Whisper expects input in the format [batch, n_mels, time]
        # We need to convert raw waveform to mel spectrogram
        # For simplicity, we'll use the Whisper feature extractor

        # Create attention mask
        if length is not None:
            max_len = x.size(1)
            attention_mask = torch.arange(max_len, device=x.device).expand(batch_size, max_len)
            attention_mask = (attention_mask < length.unsqueeze(1)).long()
        else:
            attention_mask = None

        # Extract features using encoder only (decoder is for generation)
        # For classification, we only need encoder features
        encoder_outputs = self.whisper.encoder(
            input_features=x.unsqueeze(1) if x.dim() == 2 else x,
            attention_mask=attention_mask
        )

        features = encoder_outputs.last_hidden_state

        # Pool features
        pooled = self._pool_features(features, attention_mask)

        # Classify
        logits = self.downstream(pooled)

        return logits


class WhisperWrapperWithFeatureExtractor(WhisperWrapper):
    """
    Whisper wrapper that includes feature extraction from raw audio.
    This is more complete but requires the WhisperFeatureExtractor.
    """

    def __init__(self, args, output_class_num=2):
        super().__init__(args, output_class_num)

        # Load feature extractor
        from transformers import WhisperFeatureExtractor
        model_map = {
            "whisper_tiny": "openai/whisper-tiny",
            "whisper_base": "openai/whisper-base",
            "whisper_small": "openai/whisper-small",
            "whisper_medium": "openai/whisper-medium",
            "whisper_large": "openai/whisper-large-v2"
        }
        model_name = model_map.get(args.pretrain_model, "openai/whisper-base")

        self.feature_extractor = WhisperFeatureExtractor.from_pretrained(model_name)
        logging.info("Loaded Whisper feature extractor")

    def forward(self, x, length=None):
        """
        Forward pass with feature extraction.

        Args:
            x: Input waveform [batch, time] - raw audio
            length: Length of each sample [batch]

        Returns:
            logits: [batch, num_classes]
        """
        # Convert raw audio to mel spectrogram
        # The feature extractor expects numpy arrays
        x_np = x.cpu().numpy()

        # Extract features
        inputs = self.feature_extractor(
            x_np,
            sampling_rate=16000,
            return_tensors="pt"
        )

        input_features = inputs.input_features.to(x.device)

        # Get encoder outputs
        encoder_outputs = self.whisper.encoder(input_features=input_features)
        features = encoder_outputs.last_hidden_state

        # Pool and classify
        pooled = self._pool_features(features, None)
        logits = self.downstream(pooled)

        return logits